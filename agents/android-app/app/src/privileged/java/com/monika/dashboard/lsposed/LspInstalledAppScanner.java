package com.monika.dashboard.lsposed;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.view.inputmethod.InputMethod;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Lists the apps that freeze commands may target and installed_apps reports, sorted by package
 * name. The caller runs it with system_server's own identity, so package visibility rules never
 * hide an app. Whenever the outcome changes it logs one summary line naming the third-party
 * preloads it listed and the user apps it could not see for this user (installed only in another
 * profile or app-clone space, hidden or archived), so a missing app can be explained from the
 * phone's LSPosed log.
 */
final class LspInstalledAppScanner {
    interface Host {
        void logInfo(String message);
    }

    /** Hidden PackageManager.MATCH_ANY_USER; system_server holds INTERACT_ACROSS_USERS. */
    private static final int MATCH_ANY_USER = 0x00400000;
    private static final int MAX_APPS = 2048;
    private static final int MAX_LOGGED_PACKAGES = 12;

    private final Host host;
    private volatile String lastSummary = "";

    LspInstalledAppScanner(Host host) {
        this.host = host;
    }

    List<LspInstalledApp> scan(PackageManager pm, LspProtectedPackagePolicy policy) {
        ArrayList<LspInstalledApp> out = new ArrayList<>();
        List<ApplicationInfo> installed = pm.getInstalledApplications(0);
        if (installed == null) return out;
        ArrayList<ApplicationInfo> apps = new ArrayList<>(installed);
        Collections.sort(apps, Comparator.comparing(app -> app != null ? safeString(app.packageName) : ""));
        Set<String> launchable = LspPreloadedAppPolicy.launcherPackages(pm);
        Set<String> inputMethods = inputMethodPackages(pm);
        HashSet<String> visible = new HashSet<>();
        ArrayList<String> preloads = new ArrayList<>();
        int systemSkipped = 0;
        int protectedSkipped = 0;
        int labelsMissing = 0;
        for (ApplicationInfo app : apps) {
            if (app == null) continue;
            String pkg = safeString(app.packageName);
            visible.add(pkg);
            boolean systemImage = LspPreloadedAppPolicy.isSystemImage(app);
            boolean preload = systemImage
                    && LspPreloadedAppPolicy.isThirdPartyPreload(pm, app, launchable.contains(pkg));
            boolean protectedSystemApp = systemImage && !preload;
            if (policy.isProtected(pkg, protectedSystemApp, inputMethods.contains(pkg))) {
                if (protectedSystemApp) systemSkipped++;
                else protectedSkipped++;
                continue;
            }
            if (out.size() >= MAX_APPS) continue;
            String label = label(pm, app);
            if (label.length() == 0 || label.equals(pkg)) labelsMissing++;
            out.add(new LspInstalledApp(pkg, label));
            if (preload) preloads.add(pkg);
        }
        logSummaryIfChanged(String.format(Locale.ROOT,
                "installed apps scan: listed=%d of %d, third_party_preloads=%s, system_skipped=%d, "
                        + "protected_skipped=%d, labels_missing=%d, not_visible_for_user=%s",
                out.size(), apps.size(), names(preloads), systemSkipped,
                protectedSkipped, labelsMissing, names(notVisibleUserApps(pm, visible))));
        return out;
    }

    /** Packages that provide an input method; freezing the active keyboard would block typing. */
    static Set<String> inputMethodPackages(PackageManager pm) {
        HashSet<String> out = new HashSet<>();
        for (ResolveInfo info : queryInputMethods(pm, null)) {
            if (info != null && info.serviceInfo != null && info.serviceInfo.packageName != null) {
                out.add(info.serviceInfo.packageName);
            }
        }
        return out;
    }

    static boolean providesInputMethod(PackageManager pm, String packageName) {
        return !queryInputMethods(pm, packageName).isEmpty();
    }

    private static List<ResolveInfo> queryInputMethods(PackageManager pm, String packageName) {
        try {
            Intent intent = new Intent(InputMethod.SERVICE_INTERFACE);
            if (packageName != null) intent.setPackage(packageName);
            List<ResolveInfo> found = pm.queryIntentServices(intent, LspPreloadedAppPolicy.COMPONENT_QUERY_FLAGS);
            return found != null ? found : Collections.emptyList();
        } catch (Throwable ignored) {
            return Collections.emptyList();
        }
    }

    /** User apps the device knows that this user cannot see; only for the summary line. */
    private List<String> notVisibleUserApps(PackageManager pm, Set<String> visible) {
        ArrayList<String> out = new ArrayList<>();
        try {
            List<ApplicationInfo> known = pm.getInstalledApplications(
                    PackageManager.MATCH_UNINSTALLED_PACKAGES | MATCH_ANY_USER);
            if (known == null) return out;
            for (ApplicationInfo app : known) {
                if (app == null || LspPreloadedAppPolicy.isSystemImage(app)) continue;
                String pkg = safeString(app.packageName);
                if (pkg.length() > 0 && !visible.contains(pkg)) out.add(pkg);
            }
            Collections.sort(out);
        } catch (Throwable ignored) {}
        return out;
    }

    private void logSummaryIfChanged(String summary) {
        if (summary.equals(lastSummary)) return;
        lastSummary = summary;
        host.logInfo(summary);
    }

    private static String label(PackageManager pm, ApplicationInfo app) {
        try {
            CharSequence label = pm.getApplicationLabel(app);
            String clean = label != null ? label.toString().trim() : "";
            if (clean.length() > 0) return clean;
        } catch (Throwable ignored) {}
        return app.nonLocalizedLabel != null ? app.nonLocalizedLabel.toString().trim() : "";
    }

    private static String names(List<String> packages) {
        if (packages.isEmpty()) return "0";
        int shown = Math.min(packages.size(), MAX_LOGGED_PACKAGES);
        String list = String.join(",", packages.subList(0, shown));
        return packages.size() + " [" + list + (packages.size() > shown ? ",..." : "") + "]";
    }

    private static String safeString(String value) {
        return value != null ? value.trim() : "";
    }
}
