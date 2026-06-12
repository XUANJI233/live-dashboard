package com.monika.dashboard.lsposed;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Binder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

final class LspPackageController {
    interface Host {
        Context systemContext();
        String resolveAppLabel(String packageName);
        boolean isIgnoredPackage(String packageName);
        boolean isSystemServerProcess();
        String isoTime(long millis);
        void postFreezeNotification(String packageName, String appName, String reason, long until);
        void cancelFreezeNotification(String packageName);
        void logDebug(String message);
        void logWarn(String message);
    }

    private final LspHookSupport hookSupport;
    private final Host host;
    private final String targetPackage;
    private final ConcurrentHashMap<String, FrozenPackageRecord> frozenPackages = new ConcurrentHashMap<>();

    LspPackageController(LspHookSupport hookSupport, Host host, String targetPackage) {
        this.hookSupport = hookSupport;
        this.host = host;
        this.targetPackage = targetPackage;
    }

    JSONObject frozenState(long now) {
        JSONArray frozen = frozenPackagesJson(now);
        JSONArray packages = new JSONArray();
        try {
            for (int i = 0; i < frozen.length(); i++) {
                JSONObject item = frozen.optJSONObject(i);
                if (item != null) packages.put(item.optString("package_name", ""));
            }
        } catch (Throwable ignored) {}
        JSONObject state = new JSONObject();
        try {
            state.put("frozen_apps", frozen);
            state.put("frozen_packages", packages);
        } catch (Throwable ignored) {}
        return state;
    }

    List<LspFrozenPackage> frozenPackages(long now) {
        ArrayList<LspFrozenPackage> out = new ArrayList<>();
        try {
            cleanupFrozenPackages(now);
            for (FrozenPackageRecord record : frozenPackages.values()) {
                if (record == null || record.until <= now) continue;
                out.add(new LspFrozenPackage(record.packageName, record.appName, record.mode, record.reason));
                if (out.size() >= 16) break;
            }
        } catch (Throwable t) {
            host.logDebug("device command frozen snapshot failed: " + t.getClass().getSimpleName());
        }
        return out;
    }

    boolean unfreezePackage(String packageName) {
        String pkg = safeString(packageName);
        if (pkg.length() == 0) return false;
        try {
            FrozenPackageRecord record = frozenPackages.get(pkg);
            if (record == null) return false;
            if ("suspended".equals(record.mode) && !setPackageSuspended(record.packageName, false)) {
                return false;
            }
            frozenPackages.remove(pkg);
            host.cancelFreezeNotification(record.packageName);
            return true;
        } catch (Throwable t) {
            host.logDebug("device command unfreeze failed: " + t.getClass().getSimpleName());
            return false;
        }
    }

    LspFreezeResult freezePackage(String packageName, String reason, long now, long until) {
        String pkg = safeString(packageName);
        String appName = safeString(host.resolveAppLabel(pkg));
        if (pkg.length() == 0 || isProtectedPackage(pkg)) {
            return new LspFreezeResult(pkg, appName, "", "ignored", "protected_or_empty_package", 0L);
        }
        FrozenPackageRecord existing = frozenPackages.get(pkg);
        if (existing != null && existing.until > now) {
            return new LspFreezeResult(
                    existing.packageName,
                    existing.appName,
                    existing.mode,
                    "applied",
                    "already_frozen",
                    existing.until);
        }
        boolean suspended = setPackageSuspended(pkg, true);
        boolean stopped = forceStopPackage(pkg);
        if (!suspended && !stopped) {
            return new LspFreezeResult(pkg, appName, "", "failed", "freeze_api_failed", 0L);
        }
        String mode = suspended ? "suspended" : "force_stopped";
        frozenPackages.put(pkg, new FrozenPackageRecord(pkg, appName, now, until, reason, mode));
        host.postFreezeNotification(pkg, appName, reason, until);
        return new LspFreezeResult(pkg, appName, mode, "applied", reason, until);
    }

    boolean isInstalledPackage(String packageName) {
        String pkg = safeString(packageName);
        if (pkg.length() == 0 || pkg.indexOf('.') <= 0) return false;
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return false;
            ctx.getPackageManager().getApplicationInfo(pkg, 0);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    List<LspInstalledApp> installedApps() {
        ArrayList<LspInstalledApp> out = new ArrayList<>();
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return out;
            PackageManager pm = ctx.getPackageManager();
            if (pm == null) return out;
            List<ApplicationInfo> apps = pm.getInstalledApplications(0);
            for (ApplicationInfo app : apps) {
                if (app == null || app.packageName == null || isProtectedPackage(app.packageName)) continue;
                String label = "";
                try { label = safeString(pm.getApplicationLabel(app).toString()); } catch (Throwable ignored) {}
                out.add(new LspInstalledApp(app.packageName, label));
                if (out.size() >= 512) break;
            }
        } catch (Throwable t) {
            host.logDebug("device command installed apps snapshot failed: " + t.getClass().getSimpleName());
        }
        return out;
    }

    JSONArray frozenPackagesJson(long now) {
        cleanupFrozenPackages(now);
        JSONArray arr = new JSONArray();
        try {
            for (FrozenPackageRecord record : frozenPackages.values()) {
                if (record.until <= now) continue;
                arr.put(new JSONObject()
                        .put("package_name", record.packageName)
                        .put("app_name", record.appName)
                        .put("frozen_at", host.isoTime(record.frozenAt))
                        .put("until", host.isoTime(record.until))
                        .put("mode", record.mode)
                        .put("reason", record.reason));
                if (arr.length() >= 8) break;
            }
        } catch (Throwable ignored) {}
        return arr;
    }

    boolean clear(String reason) {
        try {
            for (FrozenPackageRecord record : frozenPackages.values()) {
                if ("suspended".equals(record.mode)) setPackageSuspended(record.packageName, false);
                host.cancelFreezeNotification(record.packageName);
            }
            frozenPackages.clear();
            host.logWarn("supervision freeze cleared: " + safeString(reason));
            return true;
        } catch (Throwable t) {
            host.logDebug("clear supervision freeze failed: " + t.getClass().getSimpleName());
            return false;
        }
    }

    boolean isProtectedPackage(String packageName) {
        String pkg = safeString(packageName);
        if (pkg.length() == 0) return true;
        if (host.isIgnoredPackage(pkg)) return true;
        if (targetPackage.equals(pkg)) return true;
        if (pkg.startsWith("com.monika.dashboard")) return true;
        if (isSystemApplicationPackage(pkg)) return true;
        if (pkg.startsWith("com.android.inputmethod")) return true;
        if (pkg.startsWith("com.google.android.inputmethod")) return true;
        switch (pkg) {
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

    private void cleanupFrozenPackages(long now) {
        try {
            for (String pkg : frozenPackages.keySet()) {
                FrozenPackageRecord record = frozenPackages.get(pkg);
                if (record == null || record.until <= now) {
                    if (record != null && "suspended".equals(record.mode)) {
                        setPackageSuspended(record.packageName, false);
                    }
                    if (record != null) {
                        host.cancelFreezeNotification(record.packageName);
                    }
                    frozenPackages.remove(pkg);
                }
            }
        } catch (Throwable ignored) {}
    }

    private boolean setPackageSuspended(String packageName, boolean suspended) {
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return false;
            PackageManager pm = ctx.getPackageManager();
            if (pm == null) return false;
            Method method = findCompatibleSetPackagesSuspendedMethod(pm.getClass());
            if (method == null) return false;
            Object[] args = buildPackageSuspendedArgs(method.getParameterTypes(), packageName, suspended);
            long token = Binder.clearCallingIdentity();
            Object result;
            try {
                result = method.invoke(pm, args);
            } finally {
                Binder.restoreCallingIdentity(token);
            }
            if (result instanceof String[]) return ((String[]) result).length == 0;
            return true;
        } catch (Throwable t) {
            host.logDebug("setPackagesSuspended failed: " + t.getClass().getSimpleName());
            return false;
        }
    }

    private Method findCompatibleSetPackagesSuspendedMethod(Class<?> clazz) {
        if (clazz == null) return null;
        return hookSupport.cachedMethod(clazz, "compatibleSetPackagesSuspended", target -> {
            Method method = findSetPackagesSuspendedIn(target.getMethods());
            if (method == null) method = findSetPackagesSuspendedIn(target.getDeclaredMethods());
            return method;
        });
    }

    private Method findSetPackagesSuspendedIn(Method[] methods) {
        for (Method method : methods) {
            if (!"setPackagesSuspended".equals(method.getName())) continue;
            Class<?>[] params = method.getParameterTypes();
            boolean hasPackages = false;
            boolean hasSuspended = false;
            for (Class<?> param : params) {
                if (param.isArray() && param.getComponentType() == String.class) hasPackages = true;
                if (param == boolean.class) hasSuspended = true;
            }
            if (hasPackages && hasSuspended) return method;
        }
        return null;
    }

    private Object[] buildPackageSuspendedArgs(Class<?>[] params, String packageName, boolean suspended) {
        Object[] args = new Object[params.length];
        String message = suspended ? "Monika 监督模式短时冻结" : null;
        for (int i = 0; i < params.length; i++) {
            Class<?> type = params[i];
            if (type.isArray() && type.getComponentType() == String.class) {
                args[i] = new String[]{packageName};
            } else if (type == boolean.class) {
                args[i] = suspended;
            } else if (type == int.class) {
                args[i] = 0;
            } else if (type == String.class) {
                args[i] = message;
            } else {
                args[i] = null;
            }
        }
        return args;
    }

    private boolean forceStopPackage(String packageName) {
        if (!host.isSystemServerProcess()) return false;
        try {
            Context ctx = host.systemContext();
            if (ctx != null) {
                Object activityManager = ctx.getSystemService(Context.ACTIVITY_SERVICE);
                if (activityManager != null) {
                    Method method = hookSupport.declaredMethod(
                            activityManager.getClass(), "forceStopPackage", String.class);
                    if (method != null) {
                        long token = Binder.clearCallingIdentity();
                        try {
                            method.invoke(activityManager, packageName);
                            return true;
                        } finally {
                            Binder.restoreCallingIdentity(token);
                        }
                    }
                }
            }
        } catch (Throwable t) {
            host.logDebug("ActivityManager forceStopPackage failed: " + t.getClass().getSimpleName());
        }
        try {
            Class<?> am = hookSupport.findClass("android.app.ActivityManager");
            Method getService = am != null ? hookSupport.declaredMethod(am, "getService") : null;
            Object service = getService != null ? getService.invoke(null) : null;
            if (service == null) return false;
            Method method = hookSupport.declaredMethod(service.getClass(), "forceStopPackage", String.class, int.class);
            if (method == null) {
                method = hookSupport.declaredMethod(service.getClass(), "forceStopPackageAsUser", String.class, int.class);
            }
            if (method == null) return false;
            long token = Binder.clearCallingIdentity();
            try {
                method.invoke(service, packageName, 0);
                return true;
            } finally {
                Binder.restoreCallingIdentity(token);
            }
        } catch (Throwable t) {
            host.logWarn("IActivityManager forceStopPackage failed: " + t.getClass().getSimpleName());
            return false;
        }
    }

    private boolean isSystemApplicationPackage(String packageName) {
        try {
            if (packageName == null || packageName.length() == 0) return false;
            if (packageName.startsWith("com.android.")) return true;
            Context ctx = host.systemContext();
            if (ctx == null) return false;
            PackageManager pm = ctx.getPackageManager();
            if (pm == null) return false;
            ApplicationInfo info = pm.getApplicationInfo(packageName, 0);
            int systemFlags = ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP;
            return (info.flags & systemFlags) != 0;
        } catch (Throwable t) {
            host.logDebug("system app freeze guard failed: " + t.getClass().getSimpleName());
            return packageName != null && packageName.startsWith("com.android.");
        }
    }

    private static String safeString(String value) {
        return value != null ? value.trim() : "";
    }

    private static final class FrozenPackageRecord {
        final String packageName;
        final String appName;
        final long frozenAt;
        final long until;
        final String reason;
        final String mode;

        FrozenPackageRecord(String packageName, String appName, long frozenAt, long until, String reason, String mode) {
            this.packageName = packageName;
            this.appName = appName;
            this.frozenAt = frozenAt;
            this.until = until;
            this.reason = safeString(reason);
            this.mode = safeString(mode);
        }
    }
}
