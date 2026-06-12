package com.monika.dashboard.lsposed;

final class LspForegroundTitleState {
    private static final long BROWSER_WEB_TITLE_FRESH_MS = 10_000L;
    private static final long RECENT_FOREGROUND_BROWSER_MS = 2000L;

    private volatile String title = "";
    private volatile String source = "";
    private volatile long updatedAt = 0L;
    private volatile String recentForegroundBrowser = "";
    private volatile long recentForegroundBrowserAt = 0L;

    String title() {
        return title;
    }

    String source() {
        return source;
    }

    long updatedAt() {
        return updatedAt;
    }

    void apply(String nextTitle, String nextSource) {
        title = safeString(nextTitle);
        source = safeString(nextSource);
        updatedAt = System.currentTimeMillis();
    }

    void markForegroundBrowser(String packageName, long now) {
        if (!LspBrowserTitle.isBrowserPackage(packageName)) return;
        recentForegroundBrowser = safeString(packageName);
        recentForegroundBrowserAt = now;
    }

    boolean wasRecentForegroundBrowser(String packageName) {
        return safeString(packageName).equals(recentForegroundBrowser)
                && System.currentTimeMillis() - recentForegroundBrowserAt < RECENT_FOREGROUND_BROWSER_MS;
    }

    boolean shouldApplyBrowserCandidate(String packageName, String currentPackage, String nextTitle, String nextSource) {
        if (!LspBrowserTitle.isBrowserPackage(packageName)) return true;
        String incomingTitle = safeString(nextTitle);
        if (incomingTitle.length() == 0) return true;
        String currentTitle = title;
        if (currentTitle.length() == 0) return true;
        if (!packageName.equals(currentPackage)) return true;

        int currentRank = LspBrowserTitle.sourceRank(source);
        int incomingRank = LspBrowserTitle.sourceRank(nextSource);
        boolean currentFresh = System.currentTimeMillis() - updatedAt < BROWSER_WEB_TITLE_FRESH_MS;
        if (!currentFresh || incomingRank >= currentRank) return true;

        String currentNormalized = LspBrowserTitle.normalizeForCompare(currentTitle);
        String incomingNormalized = LspBrowserTitle.normalizeForCompare(incomingTitle);
        if (incomingNormalized.equals(currentNormalized)) return false;
        if (incomingNormalized.contains(currentNormalized)) return false;
        return !LspBrowserTitle.isVolatileSource(nextSource);
    }

    private String safeString(String value) {
        return value == null ? "" : value.trim();
    }
}
