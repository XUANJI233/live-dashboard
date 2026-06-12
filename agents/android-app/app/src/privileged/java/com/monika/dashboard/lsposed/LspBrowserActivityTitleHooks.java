package com.monika.dashboard.lsposed;

import android.app.Activity;

import java.lang.reflect.Method;
import java.util.List;

final class LspBrowserActivityTitleHooks {
    interface Host {
        void logWarn(String message);
    }

    private final LspHookSupport hookSupport;
    private final LspBrowserTitlePublisher publisher;
    private final Host host;

    LspBrowserActivityTitleHooks(
            LspHookSupport hookSupport,
            LspBrowserTitlePublisher publisher,
            Host host) {
        this.hookSupport = hookSupport;
        this.publisher = publisher;
        this.host = host;
    }

    void install(ClassLoader cl, String packageName) {
        try {
            Class<?> activity = hookSupport.findClass("android.app.Activity", cl);
            if (activity == null) return;
            hookActivityTitleText(activity, packageName);
            hookActivityTitleResource(activity, packageName);
            hookTaskDescription(activity, cl, packageName);
            hookWindowFocus(activity, packageName);
            hookWindowTitle(cl, packageName);
        } catch (Throwable t) {
            host.logWarn("activity title hook failed for "
                    + packageName + ": " + t.getClass().getSimpleName());
        }
    }

    private void hookActivityTitleText(Class<?> activity, String packageName) {
        Method method = hookSupport.declaredMethod(activity, "setTitle", CharSequence.class);
        if (method == null) return;
        hookSupport.hookAfter(method, chain -> {
            Object owner = chain.getThisObject();
            List<Object> args = chain.getArgs();
            CharSequence title = args.size() > 0 && args.get(0) instanceof CharSequence
                    ? (CharSequence) args.get(0)
                    : owner instanceof Activity ? ((Activity) owner).getTitle() : null;
            if (owner instanceof Activity && title != null) {
                publisher.publish((Activity) owner, packageName, title.toString(), "activity");
            }
        });
    }

    private void hookActivityTitleResource(Class<?> activity, String packageName) {
        Method method = hookSupport.declaredMethod(activity, "setTitle", int.class);
        if (method == null) return;
        hookSupport.hookAfter(method, chain -> {
            Object owner = chain.getThisObject();
            if (owner instanceof Activity) {
                CharSequence title = ((Activity) owner).getTitle();
                if (title != null) {
                    publisher.publish((Activity) owner, packageName, title.toString(), "activity");
                }
            }
        });
    }

    private void hookTaskDescription(Class<?> activity, ClassLoader cl, String packageName) {
        Class<?> taskDescription = hookSupport.findClass("android.app.ActivityManager$TaskDescription", cl);
        if (taskDescription == null) return;
        Method method = hookSupport.declaredMethod(activity, "setTaskDescription", taskDescription);
        if (method == null) return;
        hookSupport.hookAfter(method, chain -> {
            try {
                Object owner = chain.getThisObject();
                List<Object> args = chain.getArgs();
                if (owner instanceof Activity && args.size() > 0 && args.get(0) != null) {
                    Method getLabel = hookSupport.publicMethod(args.get(0).getClass(), "getLabel");
                    Object label = getLabel != null ? getLabel.invoke(args.get(0)) : null;
                    if (label instanceof CharSequence && ((CharSequence) label).length() > 0) {
                        publisher.publish((Activity) owner, packageName, label.toString(), "task");
                    }
                }
            } catch (Throwable ignored) {}
        });
    }

    private void hookWindowFocus(Class<?> activity, String packageName) {
        Method method = hookSupport.declaredMethod(activity, "onWindowFocusChanged", boolean.class);
        if (method == null) return;
        hookSupport.hookAfter(method, chain -> {
            List<Object> args = chain.getArgs();
            boolean hasFocus = args.size() > 0 && Boolean.TRUE.equals(args.get(0));
            Object owner = chain.getThisObject();
            if (hasFocus && owner instanceof Activity) {
                CharSequence title = ((Activity) owner).getTitle();
                if (title != null) {
                    publisher.publish((Activity) owner, packageName, title.toString(), "focus");
                }
            }
        });
    }

    private void hookWindowTitle(ClassLoader cl, String packageName) {
        try {
            Class<?> window = hookSupport.findClass("android.view.Window", cl);
            if (window == null) return;
            Method method = hookSupport.declaredMethod(window, "setTitle", CharSequence.class);
            if (method == null) return;
            hookSupport.hookAfter(method, chain -> {
                try {
                    List<Object> args = chain.getArgs();
                    if (args.size() > 0 && args.get(0) instanceof CharSequence) {
                        String title = args.get(0).toString();
                        Object windowObj = chain.getThisObject();
                        Method getContext = hookSupport.publicMethod(windowObj.getClass(), "getContext");
                        Object ctx = getContext != null ? getContext.invoke(windowObj) : null;
                        Activity activityCtx = publisher.activityContext(ctx);
                        if (activityCtx != null) {
                            publisher.publish(activityCtx, packageName, title, "window");
                        }
                    }
                } catch (Throwable ignored) {}
            });
        } catch (Throwable ignored) {}
    }
}
