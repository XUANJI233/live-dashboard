package com.monika.dashboard.lsposed;

import android.os.Handler;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class LspDirectTransport {
    interface Host {
        boolean enabled();
        boolean systemServerProcess();
        Handler uploadHandler();
        void requestDirectUpload(boolean force);
        void onReportDelivered(String body);
        void onWsTextMessage(String text);
        void onPolledDeviceCommand(JSONObject command);
        void onPolledViewerMessage(String text);
        void logInfo(String message);
        void logWarn(String message);
        void logDebug(String message);
    }

    private static final long WS_RETRY_BASE_MS = 30_000L;
    private static final long WS_RETRY_MAX_MS = 300_000L;
    private static final long WS_STATUS_ACK_TIMEOUT_MS = 4_000L;
    private static final String DEVICE_COMMAND_EVENT_PATH = "/api/supervision/ack";

    private final Host host;
    private volatile LspWebSocketClient wsClient = null;
    private volatile boolean wsReconnectPending = false;
    private volatile long wsLastFailAt = 0L;
    private volatile long wsRetryDelayMs = WS_RETRY_BASE_MS;

    LspDirectTransport(Host host) {
        this.host = host;
    }

    void disconnect() {
        LspWebSocketClient client = wsClient;
        if (client != null) {
            try { client.disconnect(); } catch (Throwable ignored) {}
        }
        wsClient = null;
        wsReconnectPending = false;
    }

    boolean sendReport(String serverUrl, String token, String body) {
        ensureWsConnected(serverUrl, token);
        final LspWebSocketClient client = wsClient;
        if (client != null && client.isConnected()) {
            try {
                String statusId = "status_" + java.util.UUID.randomUUID();
                String msg = new JSONObject()
                        .put("type", "device_status")
                        .put("status_id", statusId)
                        .put("payload", new JSONObject(body))
                        .toString();
                if (client.sendStatusTextAndWaitAck(msg, statusId, WS_STATUS_ACK_TIMEOUT_MS)) {
                    host.onReportDelivered(body);
                    host.logDebug("ws upload OK");
                    return true;
                }
                host.logDebug("ws upload ack timeout; falling back to HTTP");
            } catch (Throwable t) {
                host.logWarn("ws send failed: " + t.getClass().getSimpleName());
            }
        }
        boolean ok = postReportFallback(serverUrl, token, body);
        if (ok) {
            host.onReportDelivered(body);
            host.logDebug("http fallback upload OK");
        } else {
            host.logWarn("http fallback upload failed");
        }
        return ok;
    }

    void ensureWsConnected(String serverUrl, String token) {
        if (!host.enabled() || !host.systemServerProcess()) return;
        if (wsClient != null && wsClient.isConnected()) {
            wsRetryDelayMs = WS_RETRY_BASE_MS;
            return;
        }
        long now = System.currentTimeMillis();
        if (wsLastFailAt > 0 && now - wsLastFailAt < wsRetryDelayMs) {
            return;
        }
        synchronized (this) {
            if (wsClient != null && wsClient.isConnected()) return;
            if (wsClient != null) {
                try { wsClient.disconnect(); } catch (Throwable ignored) {}
            }
            try {
                String wsUrl = buildLspWsUrl(serverUrl);
                wsClient = new LspWebSocketClient(wsUrl, "Bearer " + token, newWebSocketListener());
                wsClient.connect();
                wsRetryDelayMs = WS_RETRY_BASE_MS;
                wsLastFailAt = 0L;
                host.logInfo("LSP WS connected to " + wsUrl);
            } catch (Throwable t) {
                wsClient = null;
                wsLastFailAt = System.currentTimeMillis();
                wsRetryDelayMs = Math.min(wsRetryDelayMs * 2, WS_RETRY_MAX_MS);
                host.logWarn("LSP WS connect failed (retry in " + (wsRetryDelayMs / 1000) + "s): "
                        + t.getClass().getSimpleName());
            }
        }
    }

    boolean sendWsText(String text) {
        LspWebSocketClient client = wsClient;
        return client != null && client.isConnected() && client.sendText(text);
    }

    boolean postDeviceCommandEvent(String baseUrl, String token, String body) {
        HttpURLConnection connection = null;
        try {
            URL url = endpoint(baseUrl, DEVICE_COMMAND_EVENT_PATH);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            connection.getOutputStream().write(bytes);
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                host.logDebug("device command event HTTP " + code);
                return false;
            }
            String response = readUtf8(connection.getInputStream());
            JSONObject json = new JSONObject(response);
            boolean received = strictBoolean(json, "received", false) || strictBoolean(json, "ok", false);
            if (!received) host.logDebug("device command event not confirmed");
            return received;
        } catch (Throwable t) {
            host.logDebug("device command event failed: " + t.getClass().getSimpleName());
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private boolean postReportFallback(String serverUrl, String token, String body) {
        HttpURLConnection connection = null;
        try {
            URL url = endpoint(serverUrl, "/api/report");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            connection.getOutputStream().write(bytes);
            int code = connection.getResponseCode();
            if (code >= 200 && code < 300) {
                host.logDebug("http upload OK");
                fetchQueuedMessagesFallback(serverUrl, token);
                return true;
            }
            host.logWarn("http upload HTTP " + code);
        } catch (Throwable t) {
            host.logWarn("http fallback upload failed: " + t.getClass().getSimpleName());
        } finally {
            if (connection != null) connection.disconnect();
        }
        return false;
    }

    private void fetchQueuedMessagesFallback(String serverUrl, String token) {
        HttpURLConnection connection = null;
        try {
            if (!host.enabled() || serverUrl.length() == 0 || token.length() == 0) return;
            URL url = endpoint(serverUrl, "/api/messages");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                host.logDebug("message fallback fetch HTTP " + code);
                return;
            }
            String body = readUtf8(connection.getInputStream());
            JSONArray messages = new JSONObject(body).optJSONArray("messages");
            if (messages == null || messages.length() == 0) return;
            for (int i = 0; i < messages.length(); i++) {
                JSONObject item = messages.optJSONObject(i);
                if (item == null) continue;
                JSONObject data = new JSONObject()
                        .put("type", "viewer_message")
                        .put("message_id", item.optString("id", ""))
                        .put("viewer_id", item.optString("viewer_id", ""))
                        .put("viewer_name", item.optString("viewer_name", ""))
                        .put("kind", item.optString("kind", "private"))
                        .put("text", item.optString("text", ""));
                Object payload = item.opt("payload");
                if (payload instanceof JSONObject) {
                    data.put("payload", payload);
                } else if (payload instanceof String && ((String) payload).length() > 0) {
                    try { data.put("payload", new JSONObject((String) payload)); } catch (Throwable ignored) {}
                }
                JSONObject payloadObject = data.optJSONObject("payload");
                if (payloadObject != null
                        && LspDeviceCommandProtocol.TYPE_COMMAND.equals(payloadObject.optString("type"))) {
                    host.onPolledDeviceCommand(payloadObject);
                    continue;
                }
                host.onPolledViewerMessage(data.toString());
            }
            host.logDebug("message fallback fetch delivered " + messages.length());
        } catch (Throwable t) {
            host.logDebug("message fallback fetch skipped: " + t.getClass().getSimpleName());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private LspWebSocketClient.Listener newWebSocketListener() {
        return new LspWebSocketClient.Listener() {
            @Override
            public void onTextMessage(String text) {
                host.onWsTextMessage(text);
            }

            @Override
            public void onDisconnected() {
                recordWsDisconnectedForBackoff();
                scheduleWsReconnect();
            }

            @Override
            public void clearIfCurrent(LspWebSocketClient client) {
                if (wsClient == client) {
                    wsClient = null;
                }
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }

    private void scheduleWsReconnect() {
        if (!host.enabled() || !host.systemServerProcess()) return;
        if (wsReconnectPending) return;
        wsReconnectPending = true;
        long delayMs = 0L;
        long lastFail = wsLastFailAt;
        if (lastFail > 0) {
            delayMs = Math.max(0L, wsRetryDelayMs - (System.currentTimeMillis() - lastFail));
        }
        Handler handler = host.uploadHandler();
        if (handler == null) {
            wsReconnectPending = false;
            return;
        }
        handler.postDelayed(() -> {
            wsReconnectPending = false;
            host.requestDirectUpload(true);
        }, delayMs);
    }

    private void recordWsDisconnectedForBackoff() {
        long now = System.currentTimeMillis();
        synchronized (this) {
            if (wsRetryDelayMs < WS_RETRY_BASE_MS) wsRetryDelayMs = WS_RETRY_BASE_MS;
            if (wsLastFailAt <= 0 || now - wsLastFailAt >= wsRetryDelayMs) {
                wsLastFailAt = now;
            }
        }
    }

    private String buildLspWsUrl(String serverUrl) {
        String base = serverUrl.replaceAll("/+$", "");
        if (base.toLowerCase().startsWith("https://")) {
            return "wss://" + base.substring(8) + "/api/ws?role=device";
        } else if (base.toLowerCase().startsWith("http://")) {
            return "ws://" + base.substring(7) + "/api/ws?role=device";
        }
        return "wss://" + base + "/api/ws?role=device";
    }

    private URL endpoint(String serverUrl, String path) throws IOException {
        return new URL(serverUrl.replaceAll("/+$", "") + path);
    }

    private String readUtf8(InputStream input) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            out.write(buffer, 0, read);
            if (out.size() > 256 * 1024) break;
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private boolean strictBoolean(JSONObject object, String key, boolean defaultWhenMissing) {
        if (object == null || !object.has(key) || object.isNull(key)) return defaultWhenMissing;
        Object value = object.opt(key);
        return value instanceof Boolean && ((Boolean) value).booleanValue();
    }
}
