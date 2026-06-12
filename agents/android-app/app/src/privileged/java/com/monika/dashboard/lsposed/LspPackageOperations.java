package com.monika.dashboard.lsposed;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Binder;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

final class LspPackageOperations {
    interface Host {
        Context systemContext();
        boolean isSystemServerProcess();
        void logDebug(String message);
        void logWarn(String message);
    }

    private static final int MAX_INSTALLED_APPS = 512;

    private final LspHookSupport hookSupport;
    private final Host host;

    LspPackageOperations(LspHookSupport hookSupport, Host host) {
        this.hookSupport = hookSupport;
        this.host = host;
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

    List<LspInstalledApp> installedApps(LspProtectedPackagePolicy protectedPolicy) {
        ArrayList<LspInstalledApp> out = new ArrayList<>();
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return out;
            PackageManager pm = ctx.getPackageManager();
            if (pm == null) return out;
            List<ApplicationInfo> installed = pm.getInstalledApplications(0);
            if (installed == null) return out;
            ArrayList<ApplicationInfo> apps = new ArrayList<>(installed);
            Collections.sort(apps, Comparator.comparing(
                    app -> app != null ? safeString(app.packageName) : ""));
            for (ApplicationInfo app : apps) {
                if (protectedPolicy.isProtectedApplication(app)) continue;
                String label = "";
                try { label = safeString(pm.getApplicationLabel(app).toString()); } catch (Throwable ignored) {}
                out.add(new LspInstalledApp(app.packageName, label));
                if (out.size() >= MAX_INSTALLED_APPS) break;
            }
        } catch (Throwable t) {
            host.logDebug("device command installed apps snapshot failed: " + t.getClass().getSimpleName());
        }
        return out;
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

    boolean isSystemApplicationPackage(String packageName) {
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
