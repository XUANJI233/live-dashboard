package com.monika.dashboard.lsposed;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps a device command result under the server's 32 KiB limit, which applies to one WS text
 * frame, the HTTP ack body and the stored result alike. An oversized result is dropped whole and
 * takes every per-package action with it, so it is compacted step by step instead: per-package
 * actions stop echoing the command's own reason, then {@code state_after} lists fewer apps (its
 * {@code frozen_packages_total} stays exact), and only as a last resort trailing actions are cut
 * and {@code actions_truncated} is set to true.
 */
final class LspCommandResultBudget {
    static final int MAX_RESULT_BYTES = 28 * 1024;
    static final String FIELD_ACTIONS_TRUNCATED = "actions_truncated";

    private LspCommandResultBudget() {}

    static JSONObject fit(JSONObject result, String commandReason) {
        if (result == null || fits(result)) return result;
        try {
            JSONArray actions = result.optJSONArray("actions");
            dropEchoedReasons(actions, commandReason);
            if (fits(result)) return result;
            JSONObject state = result.optJSONObject("state_after");
            if (state != null) {
                if (trimTail(result, state.optJSONArray(LspFrozenPackageReport.FIELD_STATE_APPS))) return result;
                if (trimTail(result, state.optJSONArray(LspFrozenPackageReport.FIELD_PACKAGES))) return result;
            }
            if (actions != null) {
                result.put(FIELD_ACTIONS_TRUNCATED, true);
                trimTail(result, actions);
            }
        } catch (Throwable ignored) {}
        return result;
    }

    static int bytes(JSONObject result) {
        return LspFrozenPackageReport.utf8Bytes(result.toString());
    }

    private static boolean fits(JSONObject result) {
        return bytes(result) <= MAX_RESULT_BYTES;
    }

    private static void dropEchoedReasons(JSONArray actions, String commandReason) {
        String echoed = commandReason != null ? commandReason.trim() : "";
        if (actions == null || echoed.length() == 0) return;
        for (int i = 0; i < actions.length(); i++) {
            JSONObject action = actions.optJSONObject(i);
            if (action == null || !action.has("package_name")) continue;
            if (echoed.equals(action.optString("reason", ""))) action.remove("reason");
        }
    }

    /** Removes items from the end until the result fits; true when it does. */
    private static boolean trimTail(JSONObject result, JSONArray items) {
        if (items == null) return fits(result);
        int size = bytes(result);
        for (int i = items.length() - 1; i >= 0 && size > MAX_RESULT_BYTES; i--) {
            size -= itemBytes(items.opt(i)) + 1;
            items.remove(i);
        }
        while (items.length() > 0 && !fits(result)) items.remove(items.length() - 1);
        return fits(result);
    }

    private static int itemBytes(Object item) {
        if (item instanceof String) return LspFrozenPackageReport.utf8Bytes(JSONObject.quote((String) item));
        return LspFrozenPackageReport.utf8Bytes(String.valueOf(item));
    }
}
