package com.monika.dashboard.lsposed;

import android.content.pm.ApplicationInfo;

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

    boolean isProtectedPackage(String packageName) {
        String pkg = safeString(packageName);
        if (pkg.length() == 0) return true;
        return isProtectedPackage(pkg, operations.isSystemApplicationPackage(pkg));
    }

    boolean isProtectedApplication(ApplicationInfo app) {
        if (app == null) return true;
        int systemFlags = ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP;
        return isProtectedPackage(safeString(app.packageName), (app.flags & systemFlags) != 0);
    }

    private boolean isProtectedPackage(String pkg, boolean systemApplication) {
        if (pkg.length() == 0) return true;
        if (host.isIgnoredPackage(pkg)) return true;
        if (targetPackage.equals(pkg)) return true;
        if (pkg.startsWith("com.monika.dashboard")) return true;
        if (systemApplication) return true;
        if (isInputMethodPackage(pkg)) return true;
        return isCriticalPlatformPackage(pkg);
    }

    private boolean isInputMethodPackage(String packageName) {
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
