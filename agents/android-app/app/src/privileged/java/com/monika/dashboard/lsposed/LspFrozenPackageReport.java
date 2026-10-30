package com.monika.dashboard.lsposed;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * JSON view of the phone's active freezes for `/api/report` and command results. Items are
 * listed oldest freeze first and stop at the item and byte limits, while
 * {@code frozen_packages_total} always counts every active freeze, so the server can tell the
 * list is complete when its length equals the total.
 */
final class LspFrozenPackageReport {
    static final String FIELD_PACKAGES = "frozen_packages";
    static final String FIELD_TOTAL = "frozen_packages_total";
    static final String FIELD_STATE_APPS = "frozen_apps";
    /** Matches the server's MAX_FROZEN_ITEMS. */
    static final int MAX_ITEMS = 80;
    /** The server keeps at most 180 characters of a freeze reason. */
    static final int MAX_REASON_CHARS = 180;
    static final int MAX_REPORT_BYTES = 24 * 1024;
    /** Command results share the server's 32 KiB result limit with their actions. */
    static final int MAX_STATE_AFTER_BYTES = 12 * 1024;

    private LspFrozenPackageReport() {}

    static void putReport(
            JSONObject device,
            List<LspFrozenPackageStore.Record> active,
            LspFrozenPackageStore.TimeFormatter formatter) throws Exception {
        device.put(FIELD_PACKAGES, items(active, formatter, MAX_REPORT_BYTES));
        device.put(FIELD_TOTAL, active.size());
    }

    static JSONObject stateAfter(
            List<LspFrozenPackageStore.Record> active,
            LspFrozenPackageStore.TimeFormatter formatter) throws Exception {
        JSONObject state = new JSONObject();
        state.put(FIELD_STATE_APPS, items(active, formatter, MAX_STATE_AFTER_BYTES));
        state.put(FIELD_PACKAGES, packageNames(active));
        state.put(FIELD_TOTAL, active.size());
        return state;
    }

    static JSONArray items(
            List<LspFrozenPackageStore.Record> active,
            LspFrozenPackageStore.TimeFormatter formatter,
            int maxBytes) throws Exception {
        JSONArray arr = new JSONArray();
        int bytes = 2;
        for (LspFrozenPackageStore.Record record : active) {
            if (arr.length() >= MAX_ITEMS) break;
            JSONObject item = new JSONObject()
                    .put("package_name", record.packageName)
                    .put("app_name", record.appName)
                    .put("frozen_at", formatter.isoTime(record.frozenAt))
                    .put("until", formatter.isoTime(record.until))
                    .put("mode", record.mode)
                    .put("reason", limit(record.reason, MAX_REASON_CHARS));
            int itemBytes = utf8Bytes(item.toString()) + 1;
            if (bytes + itemBytes > maxBytes) break;
            arr.put(item);
            bytes += itemBytes;
        }
        return arr;
    }

    static JSONArray packageNames(List<LspFrozenPackageStore.Record> active) {
        JSONArray names = new JSONArray();
        for (LspFrozenPackageStore.Record record : active) {
            if (names.length() >= MAX_ITEMS) break;
            names.put(record.packageName);
        }
        return names;
    }

    static int utf8Bytes(String text) {
        return text != null ? text.getBytes(StandardCharsets.UTF_8).length : 0;
    }

    private static String limit(String value, int maxChars) {
        if (value == null) return "";
        if (value.length() <= maxChars) return value;
        int end = Character.isHighSurrogate(value.charAt(maxChars - 1)) ? maxChars - 1 : maxChars;
        return value.substring(0, end);
    }
}
