package com.monika.dashboard.lsposed;

final class LspProtectedPackagePolicy {
    interface Host {
        boolean isIgnoredPackage(String packageName);
    }

    private final String targetPackage;
    private final LspPackageOperations operations;
    private final Host host;

    LspProtectedPackagePolicy(String targetPackage, LspPackageOperations operations, Host host) {
        this.targetPackage = safeString(targetPackage);
        this.operations = operations;
        this.host = host;
    }

    /** Name rules first; the PackageManager checks only run for packages they let through. */
    boolean isProtectedPackage(String packageName) {
        String pkg = safeString(packageName);
        if (isProtected(pkg, false, false)) return true;
        return operations.isProtectedSystemPackage(pkg) || operations.isInputMethodPackage(pkg);
    }

    /** Protection without the blanket system-app rule, for preinstalled browsers in strict browsing. */
    boolean isProtectedIgnoringSystemFlag(String packageName) {
        String pkg = safeString(packageName);
        return isProtected(pkg, false, false) || operations.isInputMethodPackage(pkg);
    }

    /**
     * The installed-apps scan already knows whether a package is a protected system app (see
     * LspPreloadedAppPolicy) and whether it provides an input method.
     */
    boolean isProtected(String packageName, boolean protectedSystemApp, boolean inputMethod) {
        String pkg = safeString(packageName);
        if (pkg.length() == 0) return true;
        if (host.isIgnoredPackage(pkg)) return true;
        if (targetPackage.equals(pkg)) return true;
        if (pkg.startsWith("com.monika.dashboard")) return true;
        if (protectedSystemApp) return true;
        if (inputMethod || hasInputMethodPrefix(pkg)) return true;
        return isCriticalPlatformPackage(pkg);
    }

    private boolean hasInputMethodPrefix(String packageName) {
        return packageName.startsWith("com.android.inputmethod")
                || packageName.startsWith("com.google.android.inputmethod");
    }

    private boolean isCriticalPlatformPackage(String packageName) {
        switch (packageName) {
            case "com.android.settings":
            case "com.miui.securitycenter":
            case "com.miui.securityadd":
            case "com.miui.powerkeeper":
            case "com.xiaomi.xmsf":
            case "com.google.android.gms":
            case "com.android.permissioncontroller":
            case "com.google.android.permissioncontroller":
            case "com.android.packageinstaller":
            case "com.google.android.packageinstaller":
            case "com.android.providers.downloads":
            case "com.android.providers.media":
            case "com.android.phone":
            case "com.google.android.dialer":
            case "com.android.contacts":
            case "com.android.server.telecom":
            case "com.android.bluetooth":
            case "com.android.nfc":
                return true;
            default:
                return false;
        }
    }

    private static String safeString(String value) {
        return value != null ? value.trim() : "";
    }
}
