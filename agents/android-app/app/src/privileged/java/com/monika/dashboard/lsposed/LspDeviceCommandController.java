package com.monika.dashboard.lsposed;

import android.os.Handler;

import org.json.JSONObject;

import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

final class LspDeviceCommandController {
    private static final int MAX_PENDING_EVENTS = 16;
    private static final int MAX_COMPLETED_RESULTS = 80;
    private static final long WS_EVENT_ACK_FALLBACK_MS = 4_000L;

    private final LspDeviceCommandHost host;
    private final LspDeviceCommandExecutor executor;
    private final ConcurrentLinkedQueue<String> pendingEvents = new ConcurrentLinkedQueue<>();
    private final ConcurrentHashMap<String, String> completedResults = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Boolean> inFlightCommands = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Boolean> wsSubmittedEvents = new ConcurrentHashMap<>();
    private volatile boolean httpFallbackScheduled = false;

    LspDeviceCommandController(LspDeviceCommandHost host) {
        this.host = host;
        this.executor = new LspDeviceCommandExecutor(host);
    }

    void flush(String serverUrl, String token) {
        if (serverUrl == null || serverUrl.length() == 0 || token == null || token.length() == 0) return;
        if (sendPendingOverWs(serverUrl, token)) {
            scheduleHttpFallback(serverUrl, token);
            return;
        }
        flushOverHttp(serverUrl, token);
    }

    private void flushOverHttp(String serverUrl, String token) {
        int sent = 0;
        while (sent < MAX_PENDING_EVENTS) {
            String body = pendingEvents.peek();
            if (body == null || body.length() == 0) return;
            if (!host.postAckHttp(serverUrl, token, body)) return;
            removePendingBody(body);
            sent++;
        }
    }

    boolean handleServerAck(String payloadText) {
        try {
            JSONObject data = new JSONObject(payloadText);
            String type = data.optString("type", "");
            if (!LspDeviceCommandProtocol.TYPE_RECEIPT_ACK.equals(type)
                    && !LspDeviceCommandProtocol.TYPE_RESULT_ACK.equals(type)) return false;
            boolean received = LspDeviceCommandProtocol.strictBoolean(data, "received", false)
                    || LspDeviceCommandProtocol.strictBoolean(data, "ok", false);
            if (received) {
                removePendingEvent(type, data.optString("command_id", ""), data.optString("result_id", ""));
            }
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    boolean handleIncomingText(String payloadText, String source) {
        try {
            JSONObject data = new JSONObject(payloadText);
            return handleCommand(data, source);
        } catch (Throwable ignored) {
            return false;
        }
    }

    boolean handleCommand(JSONObject command, String source) {
        if (command == null || !LspDeviceCommandProtocol.TYPE_COMMAND.equals(command.optString("type", ""))) return false;
        Handler handler = host.uploadHandler();
        Runnable task = () -> processCommand(command, source);
        if (handler != null) handler.post(task);
        else task.run();
        return true;
    }

    private void processCommand(JSONObject command, String source) {
        String commandId = LspDeviceCommandProtocol.cleanId(command.optString("command_id", ""));
        if (commandId.length() == 0) {
            host.logDebug("device command ignored: missing command_id");
            return;
        }

        String completed = completedResults.get(commandId);
        if (completed != null && completed.length() > 0) {
            enqueueEvent(buildReceipt(command));
            enqueueStoredResult(completed);
            return;
        }
        if (inFlightCommands.putIfAbsent(commandId, Boolean.TRUE) != null) {
            enqueueEvent(buildReceipt(command));
            return;
        }

        try {
            enqueueEvent(buildReceipt(command));
            String resultId = LspDeviceCommandProtocol.stableResultId(commandId);
            JSONObject result = executor.execute(command, resultId, source);
            completedResults.put(commandId, result.toString());
            trimCompletedResults();
            enqueueEvent(result);
        } catch (Throwable t) {
            host.logDebug("device command processing failed: " + t.getClass().getSimpleName());
        } finally {
            inFlightCommands.remove(commandId);
        }
    }

    private JSONObject buildReceipt(JSONObject command) {
        JSONObject receipt = new JSONObject();
        LspDeviceCommandProtocol.put(receipt, "type", LspDeviceCommandProtocol.TYPE_RECEIPT);
        LspDeviceCommandProtocol.put(receipt, "v", 1);
        LspDeviceCommandProtocol.put(receipt, "request_id", LspDeviceCommandProtocol.cleanId(command.optString("request_id", "")));
        LspDeviceCommandProtocol.put(receipt, "command_id", LspDeviceCommandProtocol.cleanId(command.optString("command_id", "")));
        LspDeviceCommandProtocol.put(receipt, "status", "received");
        LspDeviceCommandProtocol.put(receipt, "received_at", host.isoTime(System.currentTimeMillis()));
        return receipt;
    }

    private void enqueueStoredResult(String raw) {
        try {
            enqueueEvent(new JSONObject(raw));
        } catch (Throwable t) {
            host.logDebug("stored device command result invalid: " + t.getClass().getSimpleName());
        }
    }

    private void enqueueEvent(JSONObject event) {
        try {
            if (event == null) return;
            pendingEvents.offer(event.toString());
            while (pendingEvents.size() > MAX_PENDING_EVENTS) {
                String dropped = pendingEvents.poll();
                if (dropped != null) wsSubmittedEvents.remove(eventKey(dropped));
            }
            String serverUrl = host.directServerUrl();
            String token = host.directToken();
            Handler handler = host.uploadHandler();
            if (handler != null && serverUrl.length() > 0 && token.length() > 0) {
                handler.post(() -> flush(serverUrl, token));
            }
        } catch (Throwable t) {
            host.logDebug("device command event enqueue failed: " + t.getClass().getSimpleName());
        }
    }

    private boolean sendPendingOverWs(String serverUrl, String token) {
        host.ensureWsConnected(serverUrl, token);
        boolean hasSubmittedPending = false;
        int sent = 0;
        for (String body : pendingEvents) {
            if (body == null || body.length() == 0) continue;
            if (sent >= MAX_PENDING_EVENTS) break;
            String key = eventKey(body);
            if (wsSubmittedEvents.containsKey(key)) {
                hasSubmittedPending = true;
                continue;
            }
            if (!host.sendWsText(body)) return hasSubmittedPending;
            wsSubmittedEvents.put(key, Boolean.TRUE);
            hasSubmittedPending = true;
            sent++;
        }
        return hasSubmittedPending;
    }

    private void scheduleHttpFallback(String serverUrl, String token) {
        synchronized (this) {
            if (httpFallbackScheduled) return;
            httpFallbackScheduled = true;
        }
        Handler handler = host.uploadHandler();
        if (handler == null) {
            synchronized (this) {
                httpFallbackScheduled = false;
            }
            return;
        }
        handler.postDelayed(() -> {
            synchronized (LspDeviceCommandController.this) {
                httpFallbackScheduled = false;
            }
            flushOverHttp(serverUrl, token);
        }, WS_EVENT_ACK_FALLBACK_MS);
    }

    private boolean removePendingEvent(String responseType, String commandId, String resultId) {
        String cleanCommandId = LspDeviceCommandProtocol.cleanId(commandId);
        String cleanResultId = LspDeviceCommandProtocol.cleanId(resultId);
        try {
            for (String body : pendingEvents) {
                if (body == null || body.length() == 0) continue;
                JSONObject event = new JSONObject(body);
                String eventType = event.optString("type", "");
                if (LspDeviceCommandProtocol.TYPE_RECEIPT_ACK.equals(responseType)
                        && LspDeviceCommandProtocol.TYPE_RECEIPT.equals(eventType)
                        && cleanCommandId.equals(event.optString("command_id", ""))) {
                    return removePendingBody(body);
                }
                if (LspDeviceCommandProtocol.TYPE_RESULT_ACK.equals(responseType)
                        && LspDeviceCommandProtocol.TYPE_RESULT.equals(eventType)
                        && cleanCommandId.equals(event.optString("command_id", ""))
                        && cleanResultId.equals(event.optString("result_id", ""))) {
                    return removePendingBody(body);
                }
            }
        } catch (Throwable t) {
            host.logDebug("remove device command event failed: " + t.getClass().getSimpleName());
        }
        return false;
    }

    private boolean removePendingBody(String body) {
        boolean removed = pendingEvents.remove(body);
        if (removed) wsSubmittedEvents.remove(eventKey(body));
        return removed;
    }

    private String eventKey(String body) {
        try {
            return eventKey(new JSONObject(body));
        } catch (Throwable ignored) {
            return "raw:" + String.valueOf(body != null ? body.hashCode() : 0);
        }
    }

    private String eventKey(JSONObject event) {
        if (event == null) return "raw:0";
        return event.optString("type", "")
                + "|"
                + event.optString("command_id", "")
                + "|"
                + event.optString("result_id", "");
    }

    private void trimCompletedResults() {
        try {
            while (completedResults.size() > MAX_COMPLETED_RESULTS) {
                String key = completedResults.keys().nextElement();
                completedResults.remove(key);
            }
        } catch (Throwable ignored) {}
    }
}
