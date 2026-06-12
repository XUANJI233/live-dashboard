package com.monika.dashboard.lsposed;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

final class LspFrozenPackageStore {
    interface TimeFormatter {
        String isoTime(long millis);
    }

    interface ExpiredRecordHandler {
        void onExpired(Record record);
    }

    private static final int MAX_COMMAND_SNAPSHOT_PACKAGES = 16;
    private static final int MAX_REPORT_JSON_PACKAGES = 8;

    private final ConcurrentHashMap<String, Record> records = new ConcurrentHashMap<>();

    JSONObject frozenState(long now, TimeFormatter formatter, ExpiredRecordHandler expiredHandler) {
        JSONArray frozen = frozenPackagesJson(now, formatter, expiredHandler);
        JSONArray packages = new JSONArray();
        try {
            for (int i = 0; i < frozen.length(); i++) {
                JSONObject item = frozen.optJSONObject(i);
                if (item != null) packages.put(item.optString("package_name", ""));
            }
        } catch (Throwable ignored) {}
        JSONObject state = new JSONObject();
        try {
            state.put("frozen_apps", frozen);
            state.put("frozen_packages", packages);
        } catch (Throwable ignored) {}
        return state;
    }

    List<LspFrozenPackage> frozenPackages(long now, ExpiredRecordHandler expiredHandler) {
        cleanup(now, expiredHandler);
        ArrayList<LspFrozenPackage> out = new ArrayList<>();
        for (Record record : records.values()) {
            if (record == null || record.until <= now) continue;
            out.add(new LspFrozenPackage(record.packageName, record.appName, record.mode, record.reason));
            if (out.size() >= MAX_COMMAND_SNAPSHOT_PACKAGES) break;
        }
        return out;
    }

    JSONArray frozenPackagesJson(long now, TimeFormatter formatter, ExpiredRecordHandler expiredHandler) {
        cleanup(now, expiredHandler);
        JSONArray arr = new JSONArray();
        try {
            for (Record record : records.values()) {
                if (record == null || record.until <= now) continue;
                arr.put(new JSONObject()
                        .put("package_name", record.packageName)
                        .put("app_name", record.appName)
                        .put("frozen_at", formatter.isoTime(record.frozenAt))
                        .put("until", formatter.isoTime(record.until))
                        .put("mode", record.mode)
                        .put("reason", record.reason));
                if (arr.length() >= MAX_REPORT_JSON_PACKAGES) break;
            }
        } catch (Throwable ignored) {}
        return arr;
    }

    Record record(String packageName) {
        return records.get(packageName);
    }

    Record activeRecord(String packageName, long now) {
        Record record = records.get(packageName);
        if (record != null && record.until > now) return record;
        return null;
    }

    void put(String packageName, String appName, long now, long until, String reason, String mode) {
        records.put(packageName, new Record(packageName, appName, now, until, reason, mode));
    }

    void remove(String packageName) {
        records.remove(packageName);
    }

    List<Record> snapshot() {
        return new ArrayList<>(records.values());
    }

    void clear() {
        records.clear();
    }

    void cleanup(long now, ExpiredRecordHandler expiredHandler) {
        try {
            for (Record record : records.values()) {
                if (record == null || record.until > now) continue;
                if (records.remove(record.packageName, record) && expiredHandler != null) {
                    expiredHandler.onExpired(record);
                }
            }
        } catch (Throwable ignored) {}
    }

    static final class Record {
        final String packageName;
        final String appName;
        final long frozenAt;
        final long until;
        final String reason;
        final String mode;

        Record(String packageName, String appName, long frozenAt, long until, String reason, String mode) {
            this.packageName = packageName;
            this.appName = appName;
            this.frozenAt = frozenAt;
            this.until = until;
            this.reason = safeString(reason);
            this.mode = safeString(mode);
        }
    }

    private static String safeString(String value) {
        return value != null ? value.trim() : "";
    }
}
