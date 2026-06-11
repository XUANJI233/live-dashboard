package com.monika.dashboard.lsposed;

import java.util.Locale;

final class LspBrowserTitle {
    private static final String[] BROWSER_PACKAGES = new String[] {
            "com.android.browser",
            "com.mi.globalbrowser",
            "com.mi.browser",
            "com.heytap.browser",
            "com.vivo.browser",
            "com.huawei.browser",
            "com.android.chrome",
            "com.chrome.beta",
            "com.chrome.dev",
            "com.chrome.canary",
            "org.chromium.chrome",
            "org.chromium.webview_shell",
            "org.mozilla.firefox",
            "org.mozilla.firefox_beta",
            "org.mozilla.fenix",
            "org.mozilla.fennec_aurora",
            "org.mozilla.focus",
            "org.mozilla.klar",
            "org.mozilla.reference.browser",
            "org.torproject.torbrowser",
            "io.github.forkmaintainers.iceraven",
            "com.microsoft.emmx",
            "com.microsoft.emmx.beta",
            "com.microsoft.emmx.dev",
            "com.microsoft.emmx.canary",
            "com.brave.browser",
            "com.brave.browser_beta",
            "com.brave.browser_nightly",
            "com.vivaldi.browser",
            "com.vivaldi.browser.snapshot",
            "com.opera.browser",
            "com.opera.browser.beta",
            "com.opera.mini.native",
            "com.duckduckgo.mobile.android",
            "com.kiwibrowser.browser",
            "com.quark.browser",
            "mark.via.gp",
            "com.UCMobile.intl",
            "com.sec.android.app.sbrowser",
            "com.sec.android.app.sbrowser.beta",
            "com.yandex.browser",
            "com.yandex.browser.beta",
            "com.qwant.liberty",
            "com.ecosia.android",
            "com.arc.browser",
            "app.vanadium.browser",
            "us.spotco.fennec_dos",
            "com.cromite"
    };

    private LspBrowserTitle() {}

    static boolean isBrowserPackage(String packageName) {
        if (packageName == null) return false;
        for (String browser : BROWSER_PACKAGES) {
            if (browser.equals(packageName)) return true;
        }
        return false;
    }

    static String cleanBrowserTitle(String appLabel, String title) {
        String cleaned = cleanTitle(title);
        if (cleaned == null) return null;
        cleaned = stripBrowserTitleDecoration(appLabel, cleaned);
        if (cleaned == null) return null;
        if (isUrlLike(cleaned)) return null;
        return isGeneric(appLabel, cleaned) ? null : cleaned;
    }

    static int sourceRank(String source) {
        String normalized = safe(source).toLowerCase(Locale.US);
        if (isWebTitleSource(normalized)) return 3;
        if (normalized.startsWith("task")) return 2;
        if (normalized.startsWith("activity")
                || normalized.startsWith("window")
                || normalized.startsWith("focus")) {
            return 1;
        }
        return 0;
    }

    static boolean isVolatileSource(String source) {
        String normalized = safe(source).toLowerCase(Locale.US);
        return normalized.startsWith("window")
                || normalized.startsWith("focus");
    }

    static boolean isWebTitleSource(String source) {
        String normalized = safe(source).toLowerCase(Locale.US);
        return normalized.startsWith("web") || normalized.startsWith("aosp");
    }

    static boolean isGeneric(String appLabel, String title) {
        String normalized = normalizeForCompare(title);
        if (normalized.length() == 0) return false;
        String normalizedLabel = normalizeForCompare(appLabel);
        if (normalizedLabel.length() > 0 && normalized.equals(normalizedLabel)) return true;
        switch (normalized) {
            case "browser":
            case "web browser":
            case "internet":
            case "webview":
            case "chrome":
            case "google chrome":
            case "firefox":
            case "mozilla firefox":
            case "edge":
            case "microsoft edge":
            case "brave":
            case "opera":
            case "vivaldi":
            case "duckduckgo":
            case "samsung internet":
            case "mi browser":
            case "uc browser":
            case "new tab":
            case "about:blank":
            case "about:home":
            case "浏览器":
            case "系统浏览器":
            case "小米浏览器":
            case "网页":
            case "新标签页":
            case "空白页":
                return true;
            default:
                return false;
        }
    }

    static String normalizeForCompare(String title) {
        String cleaned = cleanTitle(title);
        if (cleaned == null) return "";
        return cleaned.toLowerCase(Locale.US)
                .replaceAll("\\s+", " ")
                .replaceAll("[\\p{Punct}。！？、，；：~～]+$", "")
                .trim();
    }

    static String cleanTitle(String title) {
        if (title == null) return null;
        String cleaned = title
                .replace('\n', ' ')
                .replace('\r', ' ')
                .replaceAll("[\\u200B-\\u200D\\uFEFF]", "")
                .trim();
        if (cleaned.length() == 0 || "null".equals(cleaned)) return null;
        if (cleaned.length() > 256) return cleaned.substring(0, 256);
        return cleaned;
    }

    private static String stripBrowserTitleDecoration(String appLabel, String title) {
        String cleaned = cleanTitle(title);
        if (cleaned == null) return null;

        String strippedPrefix = stripUrlPrefix(cleaned);
        if (strippedPrefix != null) cleaned = strippedPrefix;

        for (int i = 0; i < 2; i++) {
            String withoutSuffix = stripBrowserSuffix(appLabel, cleaned);
            if (withoutSuffix == null || withoutSuffix.equals(cleaned)) break;
            cleaned = withoutSuffix;
        }
        return cleanTitle(cleaned);
    }

    private static String stripUrlPrefix(String title) {
        String cleaned = cleanTitle(title);
        if (cleaned == null) return null;
        String[] separators = new String[] {": ", " - ", " – ", " — ", " | "};
        for (String separator : separators) {
            int index = cleaned.indexOf(separator);
            if (index <= 0 || index + separator.length() >= cleaned.length()) continue;
            String head = cleaned.substring(0, index).trim();
            String tail = cleaned.substring(index + separator.length()).trim();
            if (tail.length() == 0) continue;
            if (isUrlLike(head)) return tail;
        }
        return cleaned;
    }

    private static String stripBrowserSuffix(String appLabel, String title) {
        String cleaned = cleanTitle(title);
        if (cleaned == null) return null;
        String[] separators = new String[] {" - ", " – ", " — ", " | ", " · "};
        for (String separator : separators) {
            int index = cleaned.lastIndexOf(separator);
            if (index <= 0 || index + separator.length() >= cleaned.length()) continue;
            String head = cleaned.substring(0, index).trim();
            String tail = cleaned.substring(index + separator.length()).trim();
            if (head.length() == 0 || tail.length() == 0) continue;
            if (isKnownBrowserLabel(appLabel, tail)) return head;
        }
        return cleaned;
    }

    private static boolean isKnownBrowserLabel(String appLabel, String value) {
        String normalized = normalizeForCompare(value);
        if (normalized.length() == 0) return false;
        String normalizedLabel = normalizeForCompare(appLabel);
        if (normalizedLabel.length() > 0 && normalized.equals(normalizedLabel)) return true;
        switch (normalized) {
            case "browser":
            case "web browser":
            case "internet":
            case "chrome":
            case "google chrome":
            case "firefox":
            case "mozilla firefox":
            case "edge":
            case "microsoft edge":
            case "brave":
            case "opera":
            case "vivaldi":
            case "duckduckgo":
            case "samsung internet":
            case "mi browser":
            case "uc browser":
            case "浏览器":
            case "系统浏览器":
            case "小米浏览器":
                return true;
            default:
                return false;
        }
    }

    private static boolean isUrlLike(String title) {
        String cleaned = cleanTitle(title);
        if (cleaned == null) return false;
        String lower = cleaned.toLowerCase(Locale.US);
        if (lower.startsWith("http://")
                || lower.startsWith("https://")
                || lower.startsWith("file://")
                || lower.startsWith("content://")
                || lower.startsWith("about:")
                || lower.startsWith("chrome://")) {
            return true;
        }
        return lower.matches("^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}(:\\d+)?(/.*)?$");
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
