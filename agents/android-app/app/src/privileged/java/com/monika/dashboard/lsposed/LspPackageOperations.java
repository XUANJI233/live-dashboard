package com.monika.dashboard.lsposed;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Binder;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

final class LspPackageOperations {
    interface Host {
        Context systemContext();
        boolean isSystemServerProcess();
        void logInfo(String message);
        void logDebug(String message);
        void logWarn(String message);
    }

    private final LspHookSupport hookSupport;
    private final Host host;
    private final LspInstalledAppScanner installedAppScanner;

    LspPackageOperations(LspHookSupport hookSupport, Host host) {
        this.hookSupport = hookSupport;
        this.host = host;
        installedAppScanner = new LspInstalledAppScanner(host::logInfo);
    }

    boolean isInstalledPackage(String packageName) {
        String pkg = safeString(packageName);
        if (pkg.length() == 0 || pkg.indexOf('.') <= 0) return false;
        long token = Binder.clearCallingIdentity();
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return false;
            ctx.getPackageManager().getApplicationInfo(pkg, 0);
            return true;
        } catch (Throwable ignored) {
            return false;
        } finally {
            Binder.restoreCallingIdentity(token);
        }
    }

    /** Installed apps that declare themselves browsers (CATEGORY_APP_BROWSER). */
    List<String> browserPackages() {
        ArrayList<String> out = new ArrayList<>();
        long token = Binder.clearCallingIdentity();
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return out;
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_MAIN)
                    .addCategory(android.content.Intent.CATEGORY_APP_BROWSER);
            for (android.content.pm.ResolveInfo info : ctx.getPackageManager().queryIntentActivities(
                    intent, PackageManager.MATCH_ALL)) {
                String pkg = info.activityInfo != null ? safeString(info.activityInfo.packageName) : "";
                if (pkg.length() > 0 && !out.contains(pkg)) out.add(pkg);
            }
        } catch (Throwable t) {
            host.logDebug("browser query failed: " + t.getClass().getSimpleName());
        } finally {
            Binder.restoreCallingIdentity(token);
        }
        return out;
    }

    List<LspInstalledApp> installedApps(LspProtectedPackagePolicy protectedPolicy) {
        // Callers run on the upload thread today. Called from a binder thread, the query would
        // carry an app's calling uid and package visibility filtering would hide most apps.
        long token = Binder.clearCallingIdentity();
        try {
            Context ctx = host.systemContext();
            PackageManager pm = ctx != null ? ctx.getPackageManager() : null;
            if (pm == null) return new ArrayList<>();
            return installedAppScanner.scan(pm, protectedPolicy);
        } catch (Throwable t) {
            host.logDebug("device command installed apps snapshot failed: " + t.getClass().getSimpleName());
            return new ArrayList<>();
        } finally {
            Binder.restoreCallingIdentity(token);
        }
    }

    boolean setPackageSuspended(String packageName, boolean suspended) {
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

    boolean forceStopPackage(String packageName) {
        if (!host.isSystemServerProcess()) return false;
        if (forceStopViaContextActivityManager(packageName)) return true;
        return forceStopViaActivityManagerService(packageName);
    }

    /** System-image packages are protected, except third-party preloads the user launches. */
    boolean isProtectedSystemPackage(String packageName) {
        if (packageName == null || packageName.length() == 0) return false;
        if (packageName.startsWith("com.android.")) return true;
        long token = Binder.clearCallingIdentity();
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return false;
            PackageManager pm = ctx.getPackageManager();
            if (pm == null) return false;
            ApplicationInfo info = pm.getApplicationInfo(packageName, 0);
            if (!LspPreloadedAppPolicy.isSystemImage(info)) return false;
            return !LspPreloadedAppPolicy.isThirdPartyPreload(
                    pm, info, LspPreloadedAppPolicy.hasLauncherEntry(pm, packageName));
        } catch (Throwable t) {
            host.logDebug("system app freeze guard failed: " + t.getClass().getSimpleName());
            return false;
        } finally {
            Binder.restoreCallingIdentity(token);
        }
    }

    boolean isInputMethodPackage(String packageName) {
        if (packageName == null || packageName.length() == 0) return false;
        long token = Binder.clearCallingIdentity();
        try {
            Context ctx = host.systemContext();
            PackageManager pm = ctx != null ? ctx.getPackageManager() : null;
            return pm != null && LspInstalledAppScanner.providesInputMethod(pm, packageName);
        } catch (Throwable t) {
            host.logDebug("input method guard failed: " + t.getClass().getSimpleName());
            return false;
        } finally {
            Binder.restoreCallingIdentity(token);
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

    private boolean forceStopViaContextActivityManager(String packageName) {
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return false;
            Object activityManager = ctx.getSystemService(Context.ACTIVITY_SERVICE);
            if (activityManager == null) return false;
            Method method = hookSupport.declaredMethod(activityManager.getClass(), "forceStopPackage", String.class);
            if (method == null) return false;
            long token = Binder.clearCallingIdentity();
            try {
                method.invoke(activityManager, packageName);
                return true;
            } finally {
                Binder.restoreCallingIdentity(token);
            }
        } catch (Throwable t) {
            host.logDebug("ActivityManager forceStopPackage failed: " + t.getClass().getSimpleName());
            return false;
        }
    }

    private boolean forceStopViaActivityManagerService(String packageName) {
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

    private static String safeString(String value) {
        return value != null ? value.trim() : "";
    }
}
