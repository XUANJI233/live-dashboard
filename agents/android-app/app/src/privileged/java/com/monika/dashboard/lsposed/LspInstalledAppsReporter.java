package com.monika.dashboard.lsposed;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

final class LspInstalledAppsReporter {
    interface Host {
        List<LspInstalledApp> installedApps();
        String isoTime(long millis);
        void logWarn(String message);
    }

    private static final int MAX_INSTALLED_APPS = 512;
    private static final int MAX_SIGNATURE_CHARS = 64_000;
    private static final long REPORT_INTERVAL_MS = 6 * 60 * 60_000L;

    private final Host host;
    private volatile String lastSignature = "";
    private volatile long lastScanAt = 0L;

    LspInstalledAppsReporter(Host host) {
        this.host = host;
    }

    void putIfDue(JSONObject device, long now, boolean heartbeatOnly) {
        if (device == null || heartbeatOnly || !due(now)) return;
        try {
            List<LspInstalledApp> apps = sortedInstalledApps(host.installedApps());
            lastScanAt = now;
            if (apps.isEmpty()) return;
            String signature = signature(apps);
            if (signature.length() == 0 || signature.equals(lastSignature)) return;
            JSONArray arr = json(apps);
            if (arr.length() == 0) return;
            device.put("installed_apps", arr);
            device.put("installed_apps_updated_at", host.isoTime(now));
            lastSignature = signature;
        } catch (Throwable t) {
            host.logWarn("installed apps snapshot skipped: " + t.getClass().getSimpleName());
        }
    }

    private boolean due(long now) {
        return lastScanAt <= 0L || now - lastScanAt >= REPORT_INTERVAL_MS;
    }

    private List<LspInstalledApp> sortedInstalledApps(List<LspInstalledApp> apps) {
        if (apps == null || apps.isEmpty()) return Collections.emptyList();
        ArrayList<LspInstalledApp> out = new ArrayList<>();
        for (LspInstalledApp app : apps) {
            if (app == null || safeString(app.packageName).length() == 0) continue;
            out.add(app);
        }
        Collections.sort(out, Comparator.comparing(app -> safeString(app.packageName)));
        if (out.size() > MAX_INSTALLED_APPS) {
            return new ArrayList<>(out.subList(0, MAX_INSTALLED_APPS));
        }
        return out;
    }

    private JSONArray json(List<LspInstalledApp> apps) throws Exception {
        JSONArray arr = new JSONArray();
        for (LspInstalledApp app : apps) {
            JSONObject item = new JSONObject();
            item.put("package_name", safeString(app.packageName));
            String label = safeString(app.label);
            if (label.length() > 0) item.put("app_name", label);
            arr.put(item);
        }
        return arr;
    }

    private String signature(List<LspInstalledApp> apps) {
        StringBuilder builder = new StringBuilder();
        for (LspInstalledApp app : apps) {
            builder.append(safeString(app.packageName)).append('=').append(safeString(app.label)).append('\n');
            if (builder.length() > MAX_SIGNATURE_CHARS) break;
        }
        return builder.toString();
    }

    private static String safeString(String value) {
        return value != null ? value.trim() : "";
    }
}
