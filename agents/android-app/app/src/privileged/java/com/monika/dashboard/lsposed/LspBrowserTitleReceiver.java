package com.monika.dashboard.lsposed;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;

import androidx.core.content.ContextCompat;

final class LspBrowserTitleReceiver {
    interface Host {
        Context systemContext();
        String browserTitleNonce(boolean forceReload);
        String resolveAppLabel(String packageName);
        String foregroundPackage();
        void setBrowserForeground(String packageName, String appName, String activity);
        void onBrowserTitleAccepted();
        void logInfo(String message);
        void logWarn(String message);
        void logDebug(String message);
    }

    private static final String ACTION_BROWSER_TITLE = LspBrowserTitlePublisher.ACTION_BROWSER_TITLE;
    private final LspForegroundReader foregroundReader;
    private final LspForegroundTitleState titleState;
    private final Host host;
    private volatile boolean registered = false;

    LspBrowserTitleReceiver(
            LspForegroundReader foregroundReader,
            LspForegroundTitleState titleState,
            Host host) {
        this.foregroundReader = foregroundReader;
        this.titleState = titleState;
        this.host = host;
    }

    void markForegroundBrowser(String packageName, long now) {
        titleState.markForegroundBrowser(packageName, now);
    }

    void register(Handler handler) {
        if (registered) return;
        Context context = host.systemContext();
        if (context == null) return;
        try {
            IntentFilter filter = new IntentFilter(ACTION_BROWSER_TITLE);
            BroadcastReceiver receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    handleBroadcast(this, intent);
                }
            };
            ContextCompat.registerReceiver(
                    context,
                    receiver,
                    filter,
                    null,
                    handler,
                    ContextCompat.RECEIVER_EXPORTED);
            registered = true;
            host.logInfo("registered browser title receiver");
        } catch (Throwable t) {
            host.logWarn("browser title receiver failed: " + t.getClass().getSimpleName());
        }
    }

    private void handleBroadcast(BroadcastReceiver receiver, Intent intent) {
        try {
            if (intent == null || !ACTION_BROWSER_TITLE.equals(intent.getAction())) return;
            String pkg = intent.getStringExtra("package_name");
            String title = intent.getStringExtra("title");
            String activity = intent.getStringExtra("activity");
            String source = safeString(intent.getStringExtra("source"));
            if (!LspBrowserTitle.isBrowserPackage(pkg)) return;
            String appLabel = host.resolveAppLabel(pkg);
            String cleanTitle = LspBrowserTitle.cleanBrowserTitle(appLabel, title);
            boolean genericTitle = cleanTitle == null && LspBrowserTitle.isGeneric(appLabel, title);
            boolean clearGenericTitle = genericTitle
                    && (intent.getBooleanExtra("clear_title", false) || LspBrowserTitle.isWebTitleSource(source));
            if (cleanTitle == null && !clearGenericTitle) return;

            boolean senderVerified = senderVerified(receiver, pkg);
            String expectedNonce = host.browserTitleNonce(true);
            String actualNonce = safeString(intent.getStringExtra(LspDirectConfig.KEY_BROWSER_TITLE_NONCE));

            if (!isForegroundBrowser(pkg)) {
                host.logDebug("browser title ignored: " + pkg + " is not foreground");
                return;
            }
            if (!senderVerified && (expectedNonce.length() == 0 || !expectedNonce.equals(actualNonce))) {
                host.logDebug("browser title ignored: sender not verified and nonce mismatch for " + pkg);
                return;
            }

            host.setBrowserForeground(pkg, safeString(appLabel), safeString(activity));
            if (!titleState.shouldApplyBrowserCandidate(pkg, host.foregroundPackage(), cleanTitle, source)) {
                host.logDebug("browser title ignored by source priority: "
                        + pkg + " title=" + cleanTitle + " source=" + source);
                return;
            }

            titleState.apply(cleanTitle != null ? cleanTitle : "", source);
            host.logDebug("browser title received: " + pkg
                    + " title=" + titleState.title() + " source=" + source);
            host.onBrowserTitleAccepted();
        } catch (Throwable t) {
            host.logDebug("browser title broadcast ignored: " + t.getClass().getSimpleName());
        }
    }

    private boolean senderVerified(BroadcastReceiver receiver, String packageName) {
        if (Build.VERSION.SDK_INT < 34) return false;
        try {
            String sentPkg = receiver.getSentFromPackage();
            if (sentPkg != null && !sentPkg.equals(packageName)) {
                host.logWarn("browser title rejected: sender=" + sentPkg + " claimed=" + packageName);
                return false;
            }
            return sentPkg != null && sentPkg.equals(packageName);
        } catch (Throwable ignored) {
            return false;
        }
    }

    private boolean isForegroundBrowser(String packageName) {
        ComponentName top = foregroundReader.topActivity();
        boolean current = top != null && packageName.equals(top.getPackageName());
        boolean recent = titleState.wasRecentForegroundBrowser(packageName);
        return current || recent;
    }

    private String safeString(String value) {
        return value == null ? "" : value.trim();
    }
}
