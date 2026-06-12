package com.monika.dashboard.lsposed;

import android.content.Context;
import android.os.Handler;

final class LspBrowserFeature {
    interface Host {
        Context systemContext();
        String browserTitleNonce(boolean forceReload);
        String resolveAppLabel(String packageName);
        String resolveAppLabel(Context context, String packageName);
        boolean ignoredPackage(String packageName);
        String processName();
        String foregroundPackage();
        void setBrowserForeground(String packageName, String appName, String activity);
        void onBrowserTitleAccepted();
        void logInfo(String message);
        void logWarn(String message);
        void logDebug(String message);
    }

    private final LspBrowserTitleHooks browserTitleHooks;
    private final LspBrowserHookScope browserHookScope;
    private final LspBrowserTitleReceiver browserTitleReceiver;

    LspBrowserFeature(
            LspHookSupport hookSupport,
            LspForegroundReader foregroundReader,
            LspForegroundTitleState titleState,
            Host host) {
        browserTitleHooks = new LspBrowserTitleHooks(hookSupport, newTitleHooksHost(host));
        browserHookScope = new LspBrowserHookScope(browserTitleHooks, newHookScopeHost(host));
        browserTitleReceiver = new LspBrowserTitleReceiver(
                foregroundReader,
                titleState,
                newTitleReceiverHost(host));
    }

    void handlePackageReady(String packageName, ClassLoader classLoader) {
        browserHookScope.handlePackageReady(packageName, classLoader);
    }

    void registerReceiver(Handler handler) {
        browserTitleReceiver.register(handler);
    }

    private LspBrowserTitleHooks.Host newTitleHooksHost(Host host) {
        return new LspBrowserTitleHooks.Host() {
            @Override
            public Context systemContext() {
                return host.systemContext();
            }

            @Override
            public String browserTitleNonce() {
                return host.browserTitleNonce(false);
            }

            @Override
            public String resolveAppLabel(String packageName) {
                return host.resolveAppLabel(packageName);
            }

            @Override
            public String resolveAppLabel(Context context, String packageName) {
                return host.resolveAppLabel(context, packageName);
            }

            @Override
            public boolean isIgnoredPackage(String packageName) {
                return host.ignoredPackage(packageName);
            }

            @Override
            public void logInfo(String message) {
                host.logInfo(message);
            }

            @Override
            public void logWarn(String message) {
                host.logWarn(message);
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }

    private LspBrowserHookScope.Host newHookScopeHost(Host host) {
        return new LspBrowserHookScope.Host() {
            @Override
            public String processName() {
                return host.processName();
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }

    private LspBrowserTitleReceiver.Host newTitleReceiverHost(Host host) {
        return new LspBrowserTitleReceiver.Host() {
            @Override
            public Context systemContext() {
                return host.systemContext();
            }

            @Override
            public String browserTitleNonce(boolean forceReload) {
                return host.browserTitleNonce(forceReload);
            }

            @Override
            public String resolveAppLabel(String packageName) {
                return host.resolveAppLabel(packageName);
            }

            @Override
            public String foregroundPackage() {
                return host.foregroundPackage();
            }

            @Override
            public void setBrowserForeground(String packageName, String appName, String activity) {
                host.setBrowserForeground(packageName, appName, activity);
            }

            @Override
            public void onBrowserTitleAccepted() {
                host.onBrowserTitleAccepted();
            }

            @Override
            public void logInfo(String message) {
                host.logInfo(message);
            }

            @Override
            public void logWarn(String message) {
                host.logWarn(message);
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }
}
