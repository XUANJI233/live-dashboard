package com.monika.dashboard.lsposed;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

final class LspDirectConfig {
    static final String PREFS_NAME = "monika_lsp_direct_upload";
    static final String KEY_BROWSER_TITLE_NONCE = "browser_title_nonce";
    static final long MIN_INTERVAL_MS = 5000L;

    private static final String KEY_PENDING_BODY = "pending_direct_body";
    private static final long DEFAULT_INTERVAL_MS = 30_000L;
    private static final long MAX_INTERVAL_MS = 45_000L;
    private static final long BROWSER_NONCE_RELOAD_MS = 60_000L;

    static final class ApplyResult {
        final boolean configChanged;
        final boolean enabled;
        final String serverUrl;
        final boolean tokenPresent;

        ApplyResult(boolean configChanged, boolean enabled, String serverUrl, boolean tokenPresent) {
            this.configChanged = configChanged;
            this.enabled = enabled;
            this.serverUrl = serverUrl;
            this.tokenPresent = tokenPresent;
        }

        boolean shouldDisconnectTransport() {
            return configChanged || !enabled;
        }
    }

    interface RemotePrefs {
        SharedPreferences get() throws Throwable;
    }

    private volatile boolean enabled = false;
    private volatile String serverUrl = "";
    private volatile String token = "";
    private volatile long intervalMs = DEFAULT_INTERVAL_MS;
    private volatile boolean uploadForeground = true;
    private volatile boolean uploadMedia = true;
    private volatile boolean uploadNetwork = true;
    private volatile boolean uploadVpn = false;
    private volatile String browserTitleNonce = "";
    private volatile String pendingBody = "";
    private volatile long lastBrowserNonceLoadAt = 0L;

    boolean enabled() {
        return enabled;
    }

    boolean ready() {
        return enabled && serverUrl.length() > 0 && token.length() > 0;
    }

    String serverUrl() {
        return serverUrl;
    }

    String token() {
        return token;
    }

    long intervalMs() {
        return intervalMs;
    }

    boolean uploadForeground() {
        return uploadForeground;
    }

    boolean uploadMedia() {
        return uploadMedia;
    }

    boolean uploadNetwork() {
        return uploadNetwork;
    }

    boolean uploadVpn() {
        return uploadVpn;
    }

    String pendingBody() {
        return pendingBody;
    }

    String load(Context context, RemotePrefs remotePrefs) {
        if (context != null) {
            try {
                SharedPreferences dps = context.createDeviceProtectedStorageContext()
                        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                if (readFromPrefs(dps, true)) return "DPS";
            } catch (Throwable ignored) {}
        }
        try {
            SharedPreferences prefs = remotePrefs != null ? remotePrefs.get() : null;
            if (prefs != null && readFromPrefs(prefs, false)) return "remote prefs";
        } catch (Throwable ignored) {}
        return "";
    }

    ApplyResult applyFromBroadcast(Context context, Intent intent) {
        boolean nextEnabled = intent.getBooleanExtra("enabled", false);
        String nextServerUrl = safeString(intent.getStringExtra("server_url")).replaceAll("/+$", "");
        String nextToken = safeString(intent.getStringExtra("token"));
        int intervalSec = intent.getIntExtra("interval_sec", 30);
        boolean nextUploadForeground = intent.getBooleanExtra("upload_foreground", true);
        boolean nextUploadMedia = intent.getBooleanExtra("upload_media", true);
        boolean nextUploadNetwork = intent.getBooleanExtra("upload_network", true);
        boolean nextUploadVpn = intent.getBooleanExtra("upload_vpn", false);
        String nextBrowserTitleNonce = normalizeNonce(intent.getStringExtra(KEY_BROWSER_TITLE_NONCE));
        if (nextBrowserTitleNonce.length() == 0) nextBrowserTitleNonce = browserTitleNonce;
        long nextIntervalMs = clampInterval(intervalSec * 1000L);
        boolean configChanged = !nextServerUrl.equals(serverUrl)
                || !nextToken.equals(token)
                || nextEnabled != enabled;

        writeConfig(context,
                nextEnabled,
                nextServerUrl,
                nextToken,
                nextIntervalMs,
                nextUploadForeground,
                nextUploadMedia,
                nextUploadNetwork,
                nextUploadVpn,
                nextBrowserTitleNonce);

        enabled = nextEnabled;
        serverUrl = nextServerUrl;
        token = nextToken;
        intervalMs = nextIntervalMs;
        uploadForeground = nextUploadForeground;
        uploadMedia = nextUploadMedia;
        uploadNetwork = nextUploadNetwork;
        uploadVpn = nextUploadVpn;
        browserTitleNonce = nextBrowserTitleNonce;
        return new ApplyResult(configChanged, nextEnabled, nextServerUrl, nextToken.length() > 0);
    }

    void setPendingBody(Context context, String body) {
        String safeBody = safeString(body);
        pendingBody = safeBody;
        try {
            if (context == null) return;
            SharedPreferences prefs = context.createDeviceProtectedStorageContext()
                    .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(KEY_PENDING_BODY, safeBody).apply();
        } catch (Throwable ignored) {}
    }

    String browserTitleNonce(Context context, RemotePrefs remotePrefs, boolean forceReload) {
        String current = browserTitleNonce;
        if (current.length() > 0) return current;
        long now = System.currentTimeMillis();
        if (!forceReload && now - lastBrowserNonceLoadAt < BROWSER_NONCE_RELOAD_MS) return "";
        lastBrowserNonceLoadAt = now;
        try { load(context, remotePrefs); } catch (Throwable ignored) {}
        return browserTitleNonce;
    }

    private boolean readFromPrefs(SharedPreferences prefs, boolean requireEnabledKey) {
        if (prefs == null) return false;
        if (requireEnabledKey && !prefs.contains("enabled")) return false;
        enabled = prefs.getBoolean("enabled", false);
        serverUrl = safeString(prefs.getString("server_url", ""));
        token = safeString(prefs.getString("token", ""));
        intervalMs = clampInterval(prefs.getLong("interval_ms", DEFAULT_INTERVAL_MS));
        uploadForeground = prefs.getBoolean("upload_foreground", true);
        uploadMedia = prefs.getBoolean("upload_media", true);
        uploadNetwork = prefs.getBoolean("upload_network", true);
        uploadVpn = prefs.getBoolean("upload_vpn", false);
        browserTitleNonce = normalizeNonce(prefs.getString(KEY_BROWSER_TITLE_NONCE, ""));
        pendingBody = safeString(prefs.getString(KEY_PENDING_BODY, ""));
        return true;
    }

    private void writeConfig(
            Context context,
            boolean nextEnabled,
            String nextServerUrl,
            String nextToken,
            long nextIntervalMs,
            boolean nextUploadForeground,
            boolean nextUploadMedia,
            boolean nextUploadNetwork,
            boolean nextUploadVpn,
            String nextBrowserTitleNonce) {
        try {
            if (context == null) return;
            SharedPreferences prefs = context.createDeviceProtectedStorageContext()
                    .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit()
                    .putBoolean("enabled", nextEnabled)
                    .putString("server_url", nextServerUrl)
                    .putString("token", nextToken)
                    .putLong("interval_ms", nextIntervalMs)
                    .putBoolean("upload_foreground", nextUploadForeground)
                    .putBoolean("upload_media", nextUploadMedia)
                    .putBoolean("upload_network", nextUploadNetwork)
                    .putBoolean("upload_vpn", nextUploadVpn)
                    .putBoolean("upload_input", false)
                    .putString(KEY_BROWSER_TITLE_NONCE, nextBrowserTitleNonce)
                    .commit();
        } catch (Throwable ignored) {}
    }

    private long clampInterval(long value) {
        return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, value));
    }

    private String normalizeNonce(String value) {
        String normalized = safeString(value);
        return normalized.length() >= 24 ? normalized : "";
    }

    private String safeString(String value) {
        return value == null ? "" : value.trim();
    }
}
