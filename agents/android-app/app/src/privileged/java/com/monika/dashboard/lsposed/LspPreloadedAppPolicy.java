package com.monika.dashboard.lsposed;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Which system-image apps still count as user apps. The freeze guard protects every
 * FLAG_SYSTEM / FLAG_UPDATED_SYSTEM_APP package, but Chinese ROMs can ship third-party apps such
 * as 抖音 and 小红书 that way, and those then vanished from installed_apps and from freeze
 * matching. A system-image app is a third-party preload when the user can launch it, it runs
 * under an app uid, its package is outside the platform's, Google's, OEMs' and SoC vendors'
 * namespaces, and it is not signed with the platform certificate.
 */
final class LspPreloadedAppPolicy {
    static final int COMPONENT_QUERY_FLAGS = PackageManager.MATCH_DISABLED_COMPONENTS
            | PackageManager.MATCH_DIRECT_BOOT_AWARE
            | PackageManager.MATCH_DIRECT_BOOT_UNAWARE;
    private static final int FIRST_APPLICATION_UID = 10_000;
    private static final int PER_USER_UID_RANGE = 100_000;
    private static final String[] PLATFORM_PREFIXES = {
            "android.", "androidx.", "com.android.", "com.google.",
            "com.miui.", "com.xiaomi.", "com.mi.", "miui.", "com.milink.", "com.mipay.",
            "com.huawei.", "com.hihonor.", "com.honor.",
            "com.oplus.", "com.coloros.", "com.heytap.", "com.oppo.", "com.realme.",
            "com.oneplus.", "net.oneplus.",
            "com.vivo.", "com.bbk.", "com.iqoo.",
            "com.samsung.", "com.sec.",
            "com.motorola.", "com.lenovo.", "com.zte.", "com.nubia.", "com.meizu.", "com.flyme.",
            "com.asus.", "com.sonymobile.", "com.transsion.", "com.lge.",
            "com.qualcomm.", "com.qti.", "org.codeaurora.", "vendor.",
            "com.mediatek.", "com.mtk.", "com.unisoc.", "com.sprd.",
            "com.unionpay.",
    };

    private LspPreloadedAppPolicy() {}

    static boolean isSystemImage(ApplicationInfo app) {
        int systemFlags = ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP;
        return app != null && (app.flags & systemFlags) != 0;
    }

    /** Cheap checks first; the signature comparison only runs for the few candidates left. */
    static boolean isThirdPartyPreload(PackageManager pm, ApplicationInfo app, boolean launchable) {
        if (app == null || !isPreloadCandidate(app.packageName, app.uid, launchable)) return false;
        return !isPlatformSigned(pm, app.packageName);
    }

    static boolean isPreloadCandidate(String packageName, int uid, boolean launchable) {
        if (!launchable || packageName == null || packageName.indexOf('.') <= 0) return false;
        if (uid % PER_USER_UID_RANGE < FIRST_APPLICATION_UID) return false;
        return !isPlatformNamespace(packageName);
    }

    static boolean isPlatformNamespace(String packageName) {
        if ("android".equals(packageName)) return true;
        for (String prefix : PLATFORM_PREFIXES) {
            if (packageName.startsWith(prefix)) return true;
        }
        return false;
    }

    /** Packages with a home-screen entry, including disabled ones, for one installed-apps scan. */
    static Set<String> launcherPackages(PackageManager pm) {
        HashSet<String> out = new HashSet<>();
        for (ResolveInfo info : queryLauncherActivities(pm, null)) {
            if (info != null && info.activityInfo != null && info.activityInfo.packageName != null) {
                out.add(info.activityInfo.packageName);
            }
        }
        return out;
    }

    static boolean hasLauncherEntry(PackageManager pm, String packageName) {
        return !queryLauncherActivities(pm, packageName).isEmpty();
    }

    /** A failed query finds nothing, so system-image apps stay protected. */
    private static List<ResolveInfo> queryLauncherActivities(PackageManager pm, String packageName) {
        try {
            Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            if (packageName != null) intent.setPackage(packageName);
            List<ResolveInfo> found = pm.queryIntentActivities(intent, COMPONENT_QUERY_FLAGS);
            return found != null ? found : Collections.emptyList();
        } catch (Throwable ignored) {
            return Collections.emptyList();
        }
    }

    private static boolean isPlatformSigned(PackageManager pm, String packageName) {
        try {
            return pm.checkSignatures("android", packageName) == PackageManager.SIGNATURE_MATCH;
        } catch (Throwable ignored) {
            return true;
        }
    }
}
