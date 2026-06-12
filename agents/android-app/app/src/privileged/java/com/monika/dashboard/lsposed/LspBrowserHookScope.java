package com.monika.dashboard.lsposed;

import java.util.Locale;

final class LspBrowserHookScope {
    interface Host {
        String processName();
        void logDebug(String message);
    }

    private final LspBrowserTitleHooks browserTitleHooks;
    private final Host host;

    LspBrowserHookScope(LspBrowserTitleHooks browserTitleHooks, Host host) {
        this.browserTitleHooks = browserTitleHooks;
        this.host = host;
    }

    void handlePackageReady(String packageName, ClassLoader classLoader) {
        if (!LspBrowserTitle.isBrowserPackage(packageName)) return;
        String processName = host.processName();
        if (!shouldHookBrowserProcess(packageName, processName)) {
            host.logDebug("skip browser non-main process: " + packageName + "/" + processName);
            return;
        }
        browserTitleHooks.install(classLoader, packageName);
    }

    private boolean shouldHookBrowserProcess(String packageName, String processName) {
        if (processName == null || processName.length() == 0 || packageName.equals(processName)) {
            return true;
        }
        if (!processName.startsWith(packageName + ":")) {
            return false;
        }
        String suffix = processName.substring(packageName.length() + 1).toLowerCase(Locale.US);
        if (suffix.length() == 0) return true;
        return !suffix.contains("renderer")
                && !suffix.contains("sandbox")
                && !suffix.contains("gpu")
                && !suffix.contains("zygote")
                && !suffix.contains("privileged_process")
                && !suffix.contains("utility")
                && !suffix.contains("crash")
                && !suffix.contains("download")
                && !suffix.contains("push")
                && !suffix.contains("service");
    }
}
