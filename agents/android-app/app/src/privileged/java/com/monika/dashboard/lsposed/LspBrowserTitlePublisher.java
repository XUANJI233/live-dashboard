package com.monika.dashboard.lsposed;

import android.app.Activity;
import android.app.BroadcastOptions;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.os.Build;

final class LspBrowserTitlePublisher {
    interface Host {
        Context systemContext();
        String browserTitleNonce();
        String resolveAppLabel(String packageName);
        String resolveAppLabel(Context context, String packageName);
        boolean isIgnoredPackage(String packageName);
        void logDebug(String message);
    }

    static final String ACTION_BROWSER_TITLE = "com.monika.dashboard.LSPOSED_BROWSER_TITLE";

    private final Host host;
    private volatile long lastTitleBroadcastAt = 0L;
    private volatile String lastBroadcastTitle = "";

    LspBrowserTitlePublisher(Host host) {
        this.host = host;
    }

    Activity activityContext(Object value) {
        try {
            Object current = value;
            int depth = 0;
            while (current instanceof ContextWrapper && depth < 8) {
                if (current instanceof Activity) return (Activity) current;
                current = ((ContextWrapper) current).getBaseContext();
                depth++;
            }
            return current instanceof Activity ? (Activity) current : null;
        } catch (Throwable ignored) {
            return null;
        }
    }

    void publish(Activity activity, String packageName, String title, String source) {
        try {
            String clean = LspBrowserTitle.cleanTitle(title);
            if (clean == null || host.isIgnoredPackage(packageName)) return;
            String appLabel = host.resolveAppLabel(packageName);
            if (LspBrowserTitle.isGeneric(appLabel, clean)
                    && !LspBrowserTitle.isWebTitleSource(source)) return;
            boolean genericTitle = LspBrowserTitle.isGeneric(appLabel, clean);
            if (shouldSkipDuplicate(clean)) return;
            Context sendContext = null;
            try {
                sendContext = activity.getApplicationContext();
            } catch (Throwable ignored) {}
            if (sendContext == null) sendContext = activity;
            sendTitleBroadcast(sendContext, packageName, clean, activity.getClass().getName(), source, genericTitle);
        } catch (Throwable t) {
            host.logDebug("browser title activity publish failed: " + t.getMessage());
        }
    }

    void publish(Context context, String packageName, String title, String activityName, String source) {
        try {
            if (context == null) context = host.systemContext();
            if (context == null) return;
            String clean = LspBrowserTitle.cleanTitle(title);
            if (clean == null || host.isIgnoredPackage(packageName)) return;
            String appLabel = host.resolveAppLabel(context, packageName);
            boolean genericTitle = LspBrowserTitle.isGeneric(appLabel, clean);
            if (genericTitle && !LspBrowserTitle.isWebTitleSource(source)) return;
            if (shouldSkipDuplicate(clean)) return;
            sendTitleBroadcast(context, packageName, clean, activityName, source, genericTitle);
        } catch (Throwable t) {
            host.logDebug("browser title process publish failed: " + t.getMessage());
        }
    }

    private boolean shouldSkipDuplicate(String cleanTitle) {
        long now = System.currentTimeMillis();
        if (cleanTitle.equals(lastBroadcastTitle) && now - lastTitleBroadcastAt < 1000L) return true;
        lastBroadcastTitle = cleanTitle;
        lastTitleBroadcastAt = now;
        return false;
    }

    private void sendTitleBroadcast(
            Context context,
            String packageName,
            String cleanTitle,
            String activityName,
            String source,
            boolean genericTitle) {
        Intent intent = new Intent(ACTION_BROWSER_TITLE);
        intent.putExtra("package_name", packageName);
        intent.putExtra("title", cleanTitle);
        intent.putExtra("activity", safeString(activityName));
        intent.putExtra("source", safeString(source));
        if (genericTitle) intent.putExtra("clear_title", true);
        String nonce = host.browserTitleNonce();
        if (nonce.length() > 0) {
            intent.putExtra(LspDirectConfig.KEY_BROWSER_TITLE_NONCE, nonce);
        }
        if (Build.VERSION.SDK_INT >= 34) {
            BroadcastOptions options = BroadcastOptions.makeBasic();
            options.setShareIdentityEnabled(true);
            context.sendBroadcast(intent, null, options.toBundle());
        } else {
            context.sendBroadcast(intent);
        }
    }

    private static String safeString(String value) {
        return value == null ? "" : value.trim();
    }
}
