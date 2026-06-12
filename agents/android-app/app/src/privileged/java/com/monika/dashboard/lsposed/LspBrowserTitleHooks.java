package com.monika.dashboard.lsposed;

final class LspBrowserTitleHooks {
    interface Host extends
            LspBrowserTitlePublisher.Host,
            LspBrowserActivityTitleHooks.Host,
            LspBrowserWebViewTitleHooks.Host {
    }

    private final LspBrowserActivityTitleHooks activityTitleHooks;
    private final LspBrowserWebViewTitleHooks webViewTitleHooks;
    private final Host host;

    LspBrowserTitleHooks(LspHookSupport hookSupport, Host host) {
        this.host = host;
        LspBrowserTitlePublisher publisher = new LspBrowserTitlePublisher(host);
        activityTitleHooks = new LspBrowserActivityTitleHooks(hookSupport, publisher, host);
        webViewTitleHooks = new LspBrowserWebViewTitleHooks(hookSupport, publisher, host);
    }

    void install(ClassLoader cl, String packageName) {
        activityTitleHooks.install(cl, packageName);
        webViewTitleHooks.install(cl, packageName);
        host.logInfo("installed browser title hooks for " + packageName);
    }
}
