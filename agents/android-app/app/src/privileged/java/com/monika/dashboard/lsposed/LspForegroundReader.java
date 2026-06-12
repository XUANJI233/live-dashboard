package com.monika.dashboard.lsposed;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ActivityInfo;

import java.lang.reflect.Method;
import java.util.List;

final class LspForegroundReader {
    interface Host {
        Context systemContext();
        boolean isIgnoredPackage(String packageName);
        void logDebug(String message);
    }

    private static final long TOP_ACTIVITY_FALLBACK_MS = 120_000L;

    private final LspHookSupport hookSupport;
    private final Host host;
    private final String targetPackage;
    private volatile Object cachedAtmService = null;
    private volatile ComponentName lastKnownTopComponent = null;
    private volatile long lastKnownTopAt = 0L;

    LspForegroundReader(LspHookSupport hookSupport, Host host, String targetPackage) {
        this.hookSupport = hookSupport;
        this.host = host;
        this.targetPackage = targetPackage;
    }

    ComponentName topActivity() {
        try {
            Object service = activityTaskManagerService();
            if (service == null) return recentTopActivityFallback();
            Object info = hookSupport.invokeFirstNoArg(
                    service,
                    "getFocusedRootTaskInfo",
                    "getFocusedStackInfo");
            ComponentName top = componentFromTaskInfo(info);
            if (top == null) top = topActivityFromTasks(service);
            if (top != null) {
                lastKnownTopComponent = top;
                lastKnownTopAt = System.currentTimeMillis();
                return top;
            }
            return recentTopActivityFallback();
        } catch (Throwable ignored) {
            return recentTopActivityFallback();
        }
    }

    String focusedTaskDescription() {
        try {
            Object service = activityTaskManagerService();
            if (service == null) return null;

            Object info = hookSupport.invokeFirstNoArg(
                    service,
                    "getFocusedRootTaskInfo",
                    "getFocusedStackInfo");
            if (info == null) info = firstTaskInfo(service);
            if (info == null) return null;

            Object desc = hookSupport.readFirstField(
                    info,
                    "taskDescription",
                    "description",
                    "origDescription");
            if (desc == null) return null;

            if (desc != null && !(desc instanceof CharSequence)) {
                try {
                    Method getLabel = hookSupport.publicMethod(desc.getClass(), "getLabel");
                    if (getLabel == null) return null;
                    Object label = getLabel.invoke(desc);
                    if (label instanceof CharSequence) {
                        String result = ((CharSequence) label).toString().trim();
                        if (result.length() > 0) return result;
                    }
                } catch (Throwable ignored) {
                    // Some ROMs omit getLabel(); absence just means no usable task title.
                }
            }

            if (desc instanceof CharSequence) {
                String value = desc.toString().trim();
                if (value.length() > 0) return value;
            }
            return null;
        } catch (Throwable t) {
            host.logDebug("getFocusedTaskDescription skipped: " + t.getClass().getSimpleName());
            return null;
        }
    }

    String windowingMode() {
        try {
            Object service = activityTaskManagerService();
            if (service == null) return null;
            Object info = hookSupport.invokeFirstNoArg(
                    service,
                    "getFocusedRootTaskInfo",
                    "getFocusedStackInfo");
            if (info == null) return null;
            Object mode = hookSupport.invokeNoArg(info, "getWindowingMode");
            if (mode == null) mode = hookSupport.readField(info, "mWindowingMode");
            if (mode instanceof Integer) {
                int value = (Integer) mode;
                switch (value) {
                    case 1: return "fullscreen";
                    case 2: return "split-screen";
                    case 3: return "split-screen-secondary";
                    case 4: return "split-screen-primary";
                    case 5: return "freeform";
                    case 6: return "pip";
                    default: return "mode_" + value;
                }
            }
            return null;
        } catch (Throwable ignored) {
            return null;
        }
    }

    String deviceFormFactor() {
        try {
            Class<?> miuiBuild = hookSupport.findClass("miui.os.Build");
            Object isTablet = miuiBuild != null ? hookSupport.readStaticField(miuiBuild, "IS_TABLET") : null;
            if (Boolean.TRUE.equals(isTablet)) return "tablet";
        } catch (Throwable ignored) {}
        try {
            Context ctx = host.systemContext();
            if (ctx != null) {
                android.content.res.Configuration config = ctx.getResources().getConfiguration();
                if (config.smallestScreenWidthDp >= 600) return "tablet";
            }
        } catch (Throwable ignored) {}
        try {
            Context ctx = host.systemContext();
            if (ctx != null) {
                boolean hasFold = ctx.getPackageManager().hasSystemFeature("com.sec.feature.foldable_display")
                        || ctx.getPackageManager().hasSystemFeature("org.chromium.arc")
                        || ctx.getPackageManager().hasSystemFeature("android.hardware.type.pc");
                android.content.res.Configuration config = ctx.getResources().getConfiguration();
                int screenWidth = config.screenWidthDp;
                if ((hasFold || screenWidth >= 800) && config.smallestScreenWidthDp >= 600) return "tablet";
            }
        } catch (Throwable ignored) {}
        return "phone";
    }

    private Object activityTaskManagerService() {
        Object cached = cachedAtmService;
        if (cached != null) return cached;
        try {
            Class<?> atm = hookSupport.findClass("android.app.ActivityTaskManager");
            Method getService = atm != null ? hookSupport.declaredMethod(atm, "getService") : null;
            Object service = getService != null ? getService.invoke(null) : null;
            if (service != null) {
                cachedAtmService = service;
                return service;
            }
        } catch (Throwable ignored) {}
        try {
            Class<?> serviceManager = hookSupport.findClass("android.os.ServiceManager");
            Method getService = serviceManager != null
                    ? hookSupport.declaredMethod(serviceManager, "getService", String.class)
                    : null;
            Object binder = getService != null ? getService.invoke(null, "activity_task") : null;
            if (binder == null) return null;
            Class<?> stub = hookSupport.findClass("android.app.IActivityTaskManager$Stub");
            Method asInterface = stub != null
                    ? hookSupport.declaredMethod(stub, "asInterface", android.os.IBinder.class)
                    : null;
            Object service = asInterface != null ? asInterface.invoke(null, binder) : null;
            if (service != null) cachedAtmService = service;
            return service;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private ComponentName componentFromTaskInfo(Object info) {
        if (info == null) return null;
        String[] fields = new String[] {
                "topActivity",
                "topActivityInfo",
                "topRunningActivity",
                "resumedActivity",
                "mResumedActivity",
                "realActivity",
                "baseActivity",
                "origActivity"
        };
        for (String field : fields) {
            Object value = hookSupport.readField(info, field);
            if (value instanceof ComponentName) return (ComponentName) value;
            if (value instanceof ActivityInfo) {
                ActivityInfo activityInfo = (ActivityInfo) value;
                if (activityInfo.packageName != null && activityInfo.name != null) {
                    return new ComponentName(activityInfo.packageName, activityInfo.name);
                }
            }
        }
        return null;
    }

    private ComponentName topActivityFromTasks(Object service) {
        try {
            Method method = compatibleGetTasksMethod(service.getClass());
            if (method == null) return null;
            Object[] args = buildDefaultArgs(method.getParameterTypes(), 3);
            @SuppressWarnings("unchecked")
            List<?> tasks = (List<?>) method.invoke(service, args);
            if (tasks == null || tasks.isEmpty()) return null;
            for (Object task : tasks) {
                ComponentName top = componentFromTaskInfo(task);
                if (top == null) {
                    Object taskInfo = hookSupport.readField(task, "taskInfo");
                    top = componentFromTaskInfo(taskInfo);
                }
                if (top != null && !host.isIgnoredPackage(top.getPackageName())) return top;
            }
        } catch (Throwable t) {
            host.logDebug("getTasks top fallback failed: " + t.getClass().getSimpleName());
        }
        return null;
    }

    private Object firstTaskInfo(Object service) {
        try {
            Method getTasks = compatibleGetTasksMethod(service.getClass());
            if (getTasks == null) return null;
            @SuppressWarnings("unchecked")
            List<?> tasks = (List<?>) getTasks.invoke(service, buildDefaultArgs(getTasks.getParameterTypes(), 1));
            if (tasks == null || tasks.isEmpty()) return null;
            Object topTask = tasks.get(0);
            Object info = hookSupport.readField(topTask, "taskInfo");
            return info != null ? info : topTask;
        } catch (Throwable t) {
            host.logDebug("getTasks fallback skipped: " + t.getClass().getSimpleName());
            return null;
        }
    }

    private Method compatibleGetTasksMethod(Class<?> clazz) {
        return hookSupport.cachedMethod(clazz, "compatibleGetTasks", target -> {
            for (Method method : target.getDeclaredMethods()) {
                if (!"getTasks".equals(method.getName())) continue;
                Class<?>[] params = method.getParameterTypes();
                if (params.length == 0 || params[0] != int.class) continue;
                return method;
            }
            return null;
        });
    }

    private Object[] buildDefaultArgs(Class<?>[] params, int maxTasks) {
        Object[] args = new Object[params.length];
        for (int i = 0; i < params.length; i++) {
            Class<?> type = params[i];
            if (i == 0 && type == int.class) {
                args[i] = maxTasks;
            } else if (type == boolean.class) {
                args[i] = false;
            } else if (type == int.class) {
                args[i] = 0;
            } else if (type == long.class) {
                args[i] = 0L;
            } else if (type == float.class) {
                args[i] = 0f;
            } else if (type == double.class) {
                args[i] = 0d;
            } else if (type == String.class) {
                args[i] = targetPackage;
            } else if (type.isArray()) {
                args[i] = java.lang.reflect.Array.newInstance(type.getComponentType(), 0);
            } else if (java.util.List.class.isAssignableFrom(type)) {
                args[i] = java.util.Collections.emptyList();
            } else {
                args[i] = null;
            }
        }
        return args;
    }

    private ComponentName recentTopActivityFallback() {
        ComponentName cached = lastKnownTopComponent;
        if (cached == null) return null;
        long age = System.currentTimeMillis() - lastKnownTopAt;
        if (age >= 0 && age <= TOP_ACTIVITY_FALLBACK_MS) return cached;
        return null;
    }
}
