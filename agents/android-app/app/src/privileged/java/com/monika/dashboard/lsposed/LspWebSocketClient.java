package com.monika.dashboard.lsposed;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

final class LspWebSocketClient {
    interface Listener {
        void onTextMessage(String text);
        void onDisconnected();
        void clearIfCurrent(LspWebSocketClient client);
        void logDebug(String message);
    }

    private static final int OP_TEXT  = 0x1;
    private static final int OP_CLOSE = 0x8;
    private static final int OP_PING  = 0x9;
    private static final int OP_PONG  = 0xA;
    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int RECEIVE_BUF = 8192;
    private static final int MAX_WS_FRAME_BYTES = 256 * 1024;
    private static final int SOCKET_TIMEOUT_MS = 60_000;
    private static final int PING_INTERVAL_MS = 30_000;

    private final byte[] recvBuf = new byte[RECEIVE_BUF];
    private final byte[] pingPayload = new byte[0];
    private final String wsUrl;
    private final String authHeader;
    private final Listener listener;
    private final SecureRandom secureRandom = new SecureRandom();
    private java.net.Socket socket;
    private InputStream in;
    private OutputStream out;
    private Thread readerThread;
    private Thread pingThread;
    private volatile boolean connected;
    private volatile boolean running;
    private volatile boolean manualDisconnect;
    private final Object statusAckLock = new Object();
    private String awaitedStatusAckId = "";
    private boolean awaitedStatusAckReceived = false;

    LspWebSocketClient(String wsUrl, String authHeader, Listener listener) {
        this.wsUrl = wsUrl;
        this.authHeader = authHeader;
        this.listener = listener;
    }

    boolean isConnected() {
        return connected && socket != null && !socket.isClosed() && socket.isConnected();
    }

    void connect() throws Exception {
        boolean success = false;
        try {
            URI uri = URI.create(wsUrl);
            manualDisconnect = false;
            String host = uri.getHost();
            String scheme = uri.getScheme();
            boolean isWss = "wss".equalsIgnoreCase(scheme);
            int defaultPort = isWss ? 443 : 80;
            int port = uri.getPort() > 0 ? uri.getPort() : defaultPort;
            String path = uri.getRawPath();
            String query = uri.getRawQuery();
            String resource = path + (query != null ? "?" + query : "");
            if (resource.isEmpty()) resource = "/";

            if (isWss) {
                SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
                SSLSocket ssl = (SSLSocket) factory.createSocket();
                ssl.setTcpNoDelay(true);
                ssl.setSoTimeout(SOCKET_TIMEOUT_MS);
                boolean isIp = host.matches("[0-9.]+|[:0-9a-fA-F]+");
                javax.net.ssl.SSLParameters params = ssl.getSSLParameters();
                if (!isIp) {
                    params.setServerNames(java.util.Collections.singletonList(
                            new javax.net.ssl.SNIHostName(host)));
                }
                params.setEndpointIdentificationAlgorithm("HTTPS");
                ssl.setSSLParameters(params);
                ssl.connect(new InetSocketAddress(host, port), 8000);
                ssl.startHandshake();
                javax.net.ssl.HostnameVerifier verifier =
                        javax.net.ssl.HttpsURLConnection.getDefaultHostnameVerifier();
                if (!verifier.verify(host, ssl.getSession())) {
                    throw new IOException("Hostname verification failed: " + host);
                }
                socket = ssl;
            } else {
                java.net.Socket plain = new java.net.Socket();
                plain.setTcpNoDelay(true);
                plain.setSoTimeout(SOCKET_TIMEOUT_MS);
                plain.connect(new InetSocketAddress(host, port), 8000);
                socket = plain;
            }
            in = socket.getInputStream();
            out = socket.getOutputStream();

            byte[] keyBytes = new byte[16];
            secureRandom.nextBytes(keyBytes);
            String secKey = Base64.getEncoder().encodeToString(keyBytes);

            StringBuilder req = new StringBuilder();
            req.append("GET ").append(resource).append(" HTTP/1.1\r\n");
            req.append("Host: ").append(host);
            if (port != 443 && port != 80) req.append(":").append(port);
            req.append("\r\n");
            req.append("Upgrade: websocket\r\n");
            req.append("Connection: Upgrade\r\n");
            req.append("Sec-WebSocket-Key: ").append(secKey).append("\r\n");
            req.append("Sec-WebSocket-Version: 13\r\n");
            req.append("Authorization: ").append(authHeader).append("\r\n");
            req.append("\r\n");

            out.write(req.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();

            StringBuilder response = new StringBuilder();
            int b;
            while ((b = in.read()) != -1) {
                response.append((char) b);
                String s = response.toString();
                if (s.endsWith("\r\n\r\n")) break;
                if (s.length() > 8192) throw new IOException("response too large");
            }

            String respStr = response.toString();
            String statusLine = respStr.split("\r\n", 2)[0];
            if (!statusLine.matches("^HTTP/1\\.1 101\\b.*")) {
                throw new IOException("handshake failed: " + statusLine);
            }

            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            sha1.update((secKey + WS_GUID).getBytes(StandardCharsets.UTF_8));
            String expectedAccept = Base64.getEncoder().encodeToString(sha1.digest());
            if (!respStr.contains(expectedAccept)) {
                throw new IOException("Sec-WebSocket-Accept mismatch");
            }

            running = true;
            connected = true;
            readerThread = new Thread(this::readerLoop, "LspWsReader");
            readerThread.setDaemon(true);
            readerThread.start();

            pingThread = new Thread(this::pingLoop, "LspWsPing");
            pingThread.setDaemon(true);
            pingThread.start();
            success = true;
        } finally {
            if (!success) {
                connected = false;
                running = false;
                closeQuietly();
                listener.clearIfCurrent(this);
            }
        }
    }

    void disconnect() {
        manualDisconnect = true;
        running = false;
        connected = false;
        if (pingThread != null) {
            try { pingThread.interrupt(); } catch (Throwable ignored) {}
        }
        try {
            if (out != null) {
                sendCloseFrame(1000, "done");
            }
        } catch (Throwable ignored) {}
        closeQuietly();
    }

    boolean sendText(String text) {
        if (!connected || out == null) return false;
        try {
            byte[] payload = text.getBytes(StandardCharsets.UTF_8);
            synchronized (out) {
                sendFrame(OP_TEXT, payload, true);
                out.flush();
            }
            return true;
        } catch (Throwable t) {
            connected = false;
            closeQuietly();
            if (!manualDisconnect) listener.onDisconnected();
            return false;
        }
    }

    boolean sendStatusTextAndWaitAck(String text, String statusId, long timeoutMs) {
        String cleanStatusId = safeString(statusId);
        if (cleanStatusId.length() == 0) return false;
        synchronized (statusAckLock) {
            awaitedStatusAckId = cleanStatusId;
            awaitedStatusAckReceived = false;
        }
        if (!sendText(text)) {
            clearAwaitedStatusAck(cleanStatusId);
            return false;
        }

        long deadline = System.currentTimeMillis() + Math.max(250L, timeoutMs);
        synchronized (statusAckLock) {
            while (running && connected && !awaitedStatusAckReceived) {
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0L) break;
                try {
                    statusAckLock.wait(Math.min(remaining, 1000L));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            boolean acked = cleanStatusId.equals(awaitedStatusAckId) && awaitedStatusAckReceived;
            if (cleanStatusId.equals(awaitedStatusAckId)) {
                awaitedStatusAckId = "";
                awaitedStatusAckReceived = false;
            }
            return acked;
        }
    }

    private void closeQuietly() {
        try { if (in != null) in.close(); } catch (Throwable ignored) {}
        try { if (out != null) out.close(); } catch (Throwable ignored) {}
        try { if (socket != null) socket.close(); } catch (Throwable ignored) {}
        in = null;
        out = null;
        socket = null;
    }

    private void clearAwaitedStatusAck(String statusId) {
        synchronized (statusAckLock) {
            if (statusId.equals(awaitedStatusAckId)) {
                awaitedStatusAckId = "";
                awaitedStatusAckReceived = false;
            }
        }
    }

    private void sendCloseFrame(int code, String reason) {
        try {
            byte[] reasonBytes = reason != null ? reason.getBytes(StandardCharsets.UTF_8) : new byte[0];
            byte[] payload = new byte[2 + reasonBytes.length];
            payload[0] = (byte) ((code >> 8) & 0xFF);
            payload[1] = (byte) (code & 0xFF);
            System.arraycopy(reasonBytes, 0, payload, 2, reasonBytes.length);
            synchronized (out) {
                sendFrame(OP_CLOSE, payload, true);
                out.flush();
            }
        } catch (Throwable ignored) {}
    }

    private void sendFrame(int opcode, byte[] payload, boolean mask) throws IOException {
        int len = payload != null ? payload.length : 0;
        if (len > MAX_WS_FRAME_BYTES) {
            throw new IOException("frame too large");
        }
        out.write(0x80 | opcode);

        int maskBit = mask ? 0x80 : 0x00;
        if (len < 126) {
            out.write(maskBit | len);
        } else if (len <= 0xFFFF) {
            out.write(maskBit | 126);
            out.write((len >> 8) & 0xFF);
            out.write(len & 0xFF);
        } else {
            out.write(maskBit | 127);
            long value = len & 0xFFFFFFFFL;
            for (int i = 7; i >= 0; i--) {
                out.write((int) ((value >> (i * 8)) & 0xFF));
            }
        }

        byte[] maskKey = null;
        if (mask) {
            maskKey = new byte[4];
            secureRandom.nextBytes(maskKey);
            out.write(maskKey);
        }

        if (payload != null && len > 0) {
            if (mask) {
                byte[] masked = new byte[len];
                for (int i = 0; i < len; i++) {
                    masked[i] = (byte) (payload[i] ^ maskKey[i % 4]);
                }
                out.write(masked);
            } else {
                out.write(payload);
            }
        }
    }

    private void readerLoop() {
        boolean unexpectedDisconnect = false;
        try {
            while (running && connected) {
                byte[] frame = readFrame();
                if (frame == null) {
                    unexpectedDisconnect = true;
                    break;
                }
                int opcode = frame[0] & 0x0F;
                int payloadLen = frame.length - 1;
                byte[] payload = payloadLen > 0 ? new byte[payloadLen] : new byte[0];
                if (payloadLen > 0) System.arraycopy(frame, 1, payload, 0, payloadLen);

                switch (opcode) {
                    case OP_TEXT:
                        String text = new String(payload, StandardCharsets.UTF_8);
                        if (!handleStatusAckText(text)) {
                            listener.onTextMessage(text);
                        }
                        break;
                    case OP_PING:
                        try {
                            synchronized (out) {
                                sendFrame(OP_PONG, payload, true);
                                out.flush();
                            }
                        } catch (Throwable t) {
                            connected = false;
                            return;
                        }
                        break;
                    case OP_PONG:
                        break;
                    case OP_CLOSE:
                        connected = false;
                        running = false;
                        closeQuietly();
                        listener.clearIfCurrent(this);
                        if (!manualDisconnect) listener.onDisconnected();
                        return;
                    default:
                        break;
                }
            }
        } catch (Throwable t) {
            listener.logDebug("WS reader error: " + t.getClass().getSimpleName());
            connected = false;
            if (!manualDisconnect) listener.onDisconnected();
        } finally {
            connected = false;
            running = false;
            closeQuietly();
            listener.clearIfCurrent(this);
            if (unexpectedDisconnect && !manualDisconnect) listener.onDisconnected();
        }
    }

    private boolean handleStatusAckText(String text) {
        try {
            JSONObject json = new JSONObject(text);
            if (!"ack".equals(json.optString("type"))
                    || !"status_received".equals(json.optString("status"))) {
                return false;
            }
            String statusId = safeString(json.optString("status_id", ""));
            synchronized (statusAckLock) {
                if (statusId.length() > 0 && statusId.equals(awaitedStatusAckId)) {
                    awaitedStatusAckReceived = true;
                    statusAckLock.notifyAll();
                }
            }
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private void pingLoop() {
        while (running && connected) {
            try {
                Thread.sleep(PING_INTERVAL_MS);
            } catch (InterruptedException e) {
                break;
            }
            if (!running || !connected || out == null) break;
            try {
                synchronized (out) {
                    sendFrame(OP_PING, pingPayload, true);
                    out.flush();
                }
            } catch (Throwable t) {
                listener.logDebug("WS ping failed: " + t.getClass().getSimpleName());
                connected = false;
                break;
            }
        }
        if ((!running || !connected) && !manualDisconnect) {
            connected = false;
            running = false;
            closeQuietly();
            listener.clearIfCurrent(this);
            listener.onDisconnected();
        }
    }

    private byte[] readFrame() throws IOException {
        if (in == null) return null;

        int b0 = in.read();
        if (b0 < 0) return null;
        int opcode = b0 & 0x0F;
        int b1 = in.read();
        if (b1 < 0) return null;
        boolean masked = (b1 & 0x80) != 0;
        int len = b1 & 0x7F;

        if (len == 126) {
            int b2 = in.read();
            int b3 = in.read();
            if (b2 < 0 || b3 < 0) return null;
            len = ((b2 & 0xFF) << 8) | (b3 & 0xFF);
        } else if (len == 127) {
            long longLen = 0;
            for (int i = 0; i < 8; i++) {
                int next = in.read();
                if (next < 0) return null;
                longLen = (longLen << 8) | (next & 0xFFL);
            }
            if (longLen > Integer.MAX_VALUE) throw new IOException("frame too large");
            len = (int) longLen;
        }
        if (len > MAX_WS_FRAME_BYTES) throw new IOException("frame too large");

        byte[] maskKey = null;
        if (masked) {
            maskKey = new byte[4];
            for (int i = 0; i < 4; i++) {
                int mk = in.read();
                if (mk < 0) return null;
                maskKey[i] = (byte) mk;
            }
        }

        byte[] result = new byte[1 + len];
        result[0] = (byte) opcode;
        if (len > 0) {
            int offset = 1;
            int remaining = len;
            while (remaining > 0) {
                int read = in.read(recvBuf, 0, Math.min(recvBuf.length, remaining));
                if (read < 0) return null;
                if (read == 0) continue;
                if (masked) {
                    for (int i = 0; i < read; i++) {
                        recvBuf[i] ^= maskKey[(offset - 1 + i) % 4];
                    }
                }
                System.arraycopy(recvBuf, 0, result, offset, read);
                offset += read;
                remaining -= read;
            }
        }
        return result;
    }

    private static String safeString(String value) {
        return value == null ? "" : value;
    }
}
