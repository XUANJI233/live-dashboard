package com.monika.dashboard.lsposed;

import android.app.Activity;
import android.content.Context;
import android.view.View;
import android.webkit.WebView;

import java.lang.reflect.Method;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

final class LspBrowserWebViewTitleHooks {
    interface Host {
        void logInfo(String message);
        void logDebug(String message);
    }

    private final LspHookSupport hookSupport;
    private final LspBrowserTitlePublisher publisher;
    private final Host host;
    private final Set<String> hookedWebChromeClientClasses = ConcurrentHashMap.newKeySet();
    private final Set<String> hookedWebViewClientClasses = ConcurrentHashMap.newKeySet();
    private final Set<String> scheduledWebViewTitleReads = ConcurrentHashMap.newKeySet();

    LspBrowserWebViewTitleHooks(
            LspHookSupport hookSupport,
            LspBrowserTitlePublisher publisher,
            Host host) {
        this.hookSupport = hookSupport;
        this.publisher = publisher;
        this.host = host;
    }

    void install(ClassLoader cl, String packageName) {
        hookBaseWebChromeTitle(cl, packageName);
        installWebViewTitleHooks(cl, packageName);
        installAospBrowserTitleHooks(cl, packageName);
    }

    private void hookBaseWebChromeTitle(ClassLoader cl, String packageName) {
        try {
            Class<?> chromeClient = hookSupport.findClass("android.webkit.WebChromeClient", cl);
            Class<?> webView = hookSupport.findClass("android.webkit.WebView", cl);
            if (chromeClient == null || webView == null) return;
            Method method = hookSupport.declaredMethod(chromeClient, "onReceivedTitle", webView, String.class);
            if (method == null) return;
            hookSupport.hookAfter(method, chain -> {
                try {
                    List<Object> args = chain.getArgs();
                    if (args.size() > 1 && args.get(1) instanceof String) {
                        String title = (String) args.get(1);
                        Object webViewObject = args.get(0);
                        Method getContext = hookSupport.publicMethod(webViewObject.getClass(), "getContext");
                        Object ctx = getContext != null ? getContext.invoke(webViewObject) : null;
                        Activity activityCtx = publisher.activityContext(ctx);
                        if (activityCtx != null) {
                            publisher.publish(activityCtx, packageName, title, "webchrome");
                        } else {
                            Context sendCtx = ctx instanceof Context ? (Context) ctx : null;
                            publisher.publish(sendCtx, packageName, title, "", "webchrome");
                        }
                    }
                } catch (Throwable ignored) {}
            });
        } catch (Throwable ignored) {}
    }

    private void installWebViewTitleHooks(ClassLoader cl, String packageName) {
        try {
            Class<?> webView = hookSupport.findClass("android.webkit.WebView", cl);
            if (webView == null) return;
            hookWebViewNavigation(webView, packageName, "loadUrl", String.class);
            hookWebViewNavigation(webView, packageName, "loadUrl", String.class, java.util.Map.class);
            hookWebViewNavigation(webView, packageName, "postUrl", String.class, byte[].class);
            hookWebViewNavigation(webView, packageName, "reload");
            hookWebViewNavigation(webView, packageName, "goBack");
            hookWebViewNavigation(webView, packageName, "goForward");
            hookWebViewClientPageFinished(cl, webView, packageName);
            hookWebViewClientTitleEvent(cl, webView, packageName, "onPageCommitVisible", webView, String.class);
            hookWebViewClientTitleEvent(
                    cl,
                    webView,
                    packageName,
                    "doUpdateVisitedHistory",
                    webView,
                    String.class,
                    boolean.class);
            hookWebViewClientTitleEvent(cl, webView, packageName, "shouldOverrideUrlLoading", webView, String.class);
            Class<?> request = hookSupport.findClass("android.webkit.WebResourceRequest", cl);
            if (request != null) {
                hookWebViewClientTitleEvent(cl, webView, packageName, "shouldOverrideUrlLoading", webView, request);
            }
            hookWebChromeProgress(cl, webView, packageName);
            hookWebViewClientInstallers(webView, packageName);
        } catch (Throwable ignored) {}
    }

    private void hookWebViewClientInstallers(Class<?> webView, String packageName) {
        try {
            Class<?> chromeClient = hookSupport.findClass("android.webkit.WebChromeClient", webView.getClassLoader());
            if (chromeClient != null) {
                Method method = hookSupport.declaredMethod(webView, "setWebChromeClient", chromeClient);
                if (method != null) {
                    hookSupport.hookAfter(method, chain -> {
                        try {
                            List<Object> args = chain.getArgs();
                            if (args.size() > 0 && args.get(0) != null) {
                                hookSpecificWebChromeClient(args.get(0).getClass(), webView, packageName);
                            }
                        } catch (Throwable ignored) {}
                    });
                    host.logInfo("hooked WebView#setWebChromeClient for " + packageName);
                }
            }
        } catch (Throwable ignored) {}

        try {
            Class<?> viewClient = hookSupport.findClass("android.webkit.WebViewClient", webView.getClassLoader());
            if (viewClient != null) {
                Method method = hookSupport.declaredMethod(webView, "setWebViewClient", viewClient);
                if (method != null) {
                    hookSupport.hookAfter(method, chain -> {
                        try {
                            List<Object> args = chain.getArgs();
                            if (args.size() > 0 && args.get(0) != null) {
                                hookSpecificWebViewClient(args.get(0).getClass(), webView, packageName);
                            }
                        } catch (Throwable ignored) {}
                    });
                    host.logInfo("hooked WebView#setWebViewClient for " + packageName);
                }
            }
        } catch (Throwable ignored) {}
    }

    private void hookSpecificWebChromeClient(Class<?> clientClass, Class<?> webView, String packageName) {
        if (clientClass == null) return;
        String className = clientClass.getName();
        if (!hookedWebChromeClientClasses.add(packageName + ":" + className)) return;
        Method method = hookSupport.declaredMethod(clientClass, "onReceivedTitle", webView, String.class);
        if (method == null) return;
        hookSupport.hookAfter(method, chain -> {
            try {
                List<Object> args = chain.getArgs();
                if (args.size() > 1 && args.get(1) instanceof String) {
                    publishTitleFromWebView(args.get(0), packageName, (String) args.get(1), "webchrome");
                }
            } catch (Throwable ignored) {}
        });
        host.logInfo("hooked concrete WebChromeClient#onReceivedTitle: " + className);
        hookSpecificWebChromeProgress(clientClass, webView, packageName);
    }

    private void hookSpecificWebViewClient(Class<?> clientClass, Class<?> webView, String packageName) {
        if (clientClass == null) return;
        String className = clientClass.getName();
        if (!hookedWebViewClientClasses.add(packageName + ":" + className)) return;
        Method method = hookSupport.declaredMethod(clientClass, "onPageFinished", webView, String.class);
        if (method == null) return;
        hookSupport.hookAfter(method, chain -> {
            try {
                List<Object> args = chain.getArgs();
                if (args.size() > 0) {
                    scheduleWebViewTitleRead(args.get(0), packageName, 150L);
                    scheduleWebViewTitleRead(args.get(0), packageName, 900L);
                }
            } catch (Throwable ignored) {}
        });
        host.logInfo("hooked concrete WebViewClient#onPageFinished: " + className);
        hookSpecificWebViewClientTitleEvent(
                clientClass,
                webView,
                packageName,
                "onPageCommitVisible",
                webView,
                String.class);
        hookSpecificWebViewClientTitleEvent(
                clientClass,
                webView,
                packageName,
                "doUpdateVisitedHistory",
                webView,
                String.class,
                boolean.class);
        hookSpecificWebViewClientTitleEvent(
                clientClass,
                webView,
                packageName,
                "shouldOverrideUrlLoading",
                webView,
                String.class);
        Class<?> request = hookSupport.findClass("android.webkit.WebResourceRequest", webView.getClassLoader());
        if (request != null) {
            hookSpecificWebViewClientTitleEvent(
                    clientClass,
                    webView,
                    packageName,
                    "shouldOverrideUrlLoading",
                    webView,
                    request);
        }
    }

    private void hookWebViewClientPageFinished(ClassLoader cl, Class<?> webView, String packageName) {
        try {
            Class<?> viewClient = hookSupport.findClass("android.webkit.WebViewClient", cl);
            if (viewClient == null) return;
            Method method = hookSupport.declaredMethod(viewClient, "onPageFinished", webView, String.class);
            if (method == null) return;
            hookSupport.hookAfter(method, chain -> {
                try {
                    List<Object> args = chain.getArgs();
                    if (args.size() > 0) {
                        scheduleWebViewTitleRead(args.get(0), packageName, 150L);
                        scheduleWebViewTitleRead(args.get(0), packageName, 900L);
                    }
                } catch (Throwable ignored) {}
            });
            host.logInfo("hooked WebViewClient#onPageFinished for " + packageName);
        } catch (Throwable ignored) {}
    }

    private void installAospBrowserTitleHooks(ClassLoader cl, String packageName) {
        if (!"com.android.browser".equals(packageName)) return;
        try {
            Class<?> browserActivity = hookSupport.findClass("com.android.browser.BrowserActivity", cl);
            if (browserActivity == null) return;
            Method setUrlTitle = hookSupport.declaredMethod(browserActivity, "setUrlTitle", String.class, String.class);
            if (setUrlTitle != null) {
                hookSupport.hookAfter(setUrlTitle, chain -> {
                    try {
                        Object owner = chain.getThisObject();
                        List<Object> args = chain.getArgs();
                        if (owner instanceof Activity && args.size() > 1 && args.get(1) instanceof String) {
                            publisher.publish((Activity) owner, packageName, (String) args.get(1), "aosp");
                        }
                    } catch (Throwable ignored) {}
                });
                host.logInfo("hooked AOSP BrowserActivity#setUrlTitle");
            }

            Class<?> webView = hookSupport.findClass("android.webkit.WebView", cl);
            if (webView != null) {
                hookAospBrowserPageCallback(browserActivity, packageName, "onPageFinished", webView, String.class);
            }
        } catch (Throwable t) {
            host.logDebug("AOSP browser title hooks skipped: " + t.getClass().getSimpleName());
        }
    }

    private void hookAospBrowserPageCallback(
            Class<?> browserActivity,
            String packageName,
            String methodName,
            Class<?>... paramTypes) {
        Method method = hookSupport.declaredMethod(browserActivity, methodName, paramTypes);
        if (method == null) return;
        hookSupport.hookAfter(method, chain -> {
            try {
                List<Object> args = chain.getArgs();
                if (args.size() > 0) {
                    scheduleWebViewTitleRead(args.get(0), packageName, 150L);
                    scheduleWebViewTitleRead(args.get(0), packageName, 900L);
                }
            } catch (Throwable ignored) {}
        });
        host.logInfo("hooked AOSP BrowserActivity#" + methodName);
    }

    private void hookWebViewNavigation(Class<?> webView, String packageName, String methodName, Class<?>... paramTypes) {
        Method method = hookSupport.declaredMethod(webView, methodName, paramTypes);
        if (method == null) return;
        hookSupport.hookAfter(method, chain -> {
            Object owner = chain.getThisObject();
            scheduleWebViewTitleRead(owner, packageName, 900L);
            scheduleWebViewTitleRead(owner, packageName, 2500L);
        });
    }

    private void scheduleWebViewTitleRead(Object webView, String packageName, long delayMs) {
        if (webView == null) return;
        String key = packageName + ":" + System.identityHashCode(webView) + ":" + delayMs;
        try {
            if (webView instanceof View) {
                if (!scheduledWebViewTitleReads.add(key)) return;
                boolean posted = ((View) webView).postDelayed(() -> {
                    try {
                        publishTitleFromWebView(webView, packageName);
                    } finally {
                        scheduledWebViewTitleReads.remove(key);
                    }
                }, delayMs);
                if (!posted) scheduledWebViewTitleReads.remove(key);
                return;
            }
            Method postDelayed = hookSupport.publicMethod(webView.getClass(), "postDelayed", Runnable.class, long.class);
            if (postDelayed == null) return;
            if (!scheduledWebViewTitleReads.add(key)) return;
            postDelayed.invoke(webView, (Runnable) () -> {
                try {
                    publishTitleFromWebView(webView, packageName);
                } finally {
                    scheduledWebViewTitleReads.remove(key);
                }
            }, delayMs);
        } catch (Throwable ignored) {
            scheduledWebViewTitleReads.remove(key);
        }
    }

    private void publishTitleFromWebView(Object webView, String packageName) {
        publishTitleFromWebView(webView, packageName, "", "webview");
    }

    private void publishTitleFromWebView(Object webView, String packageName, String explicitTitle, String source) {
        try {
            Object rawTitle = explicitTitle != null && explicitTitle.trim().length() > 0 ? explicitTitle : null;
            Object ctx;
            if (webView instanceof WebView) {
                WebView view = (WebView) webView;
                if (rawTitle == null) rawTitle = view.getTitle();
                ctx = view.getContext();
            } else {
                if (rawTitle == null) {
                    Method getTitle = hookSupport.publicMethod(webView.getClass(), "getTitle");
                    if (getTitle == null) return;
                    rawTitle = getTitle.invoke(webView);
                }
                Method getContext = hookSupport.publicMethod(webView.getClass(), "getContext");
                if (getContext == null) return;
                ctx = getContext.invoke(webView);
            }
            if (!(rawTitle instanceof String)) return;
            String title = (String) rawTitle;
            Activity activityCtx = publisher.activityContext(ctx);
            if (activityCtx != null) {
                publisher.publish(activityCtx, packageName, title, source);
            } else {
                publisher.publish(ctx instanceof Context ? (Context) ctx : null, packageName, title, "", source);
            }
        } catch (Throwable ignored) {}
    }

    private void hookWebViewClientTitleEvent(
            ClassLoader cl,
            Class<?> webView,
            String packageName,
            String methodName,
            Class<?>... paramTypes) {
        try {
            Class<?> viewClient = hookSupport.findClass("android.webkit.WebViewClient", cl);
            if (viewClient != null) {
                hookSpecificWebViewClientTitleEvent(viewClient, webView, packageName, methodName, paramTypes);
            }
        } catch (Throwable ignored) {}
    }

    private void hookSpecificWebViewClientTitleEvent(
            Class<?> clientClass,
            Class<?> webView,
            String packageName,
            String methodName,
            Class<?>... paramTypes) {
        if (clientClass == null) return;
        String className = clientClass.getName();
        String hookKey = packageName + ":" + className + ":" + methodName + ":" + hookSupport.signatureKey(paramTypes);
        if (!hookedWebViewClientClasses.add(hookKey)) return;
        Method method = hookSupport.declaredMethod(clientClass, methodName, paramTypes);
        if (method == null) return;
        hookSupport.hookAfter(method, chain -> {
            try {
                List<Object> args = chain.getArgs();
                if (args.size() > 0) {
                    scheduleWebViewTitleRead(args.get(0), packageName, 120L);
                    scheduleWebViewTitleRead(args.get(0), packageName, 650L);
                    scheduleWebViewTitleRead(args.get(0), packageName, 1800L);
                }
            } catch (Throwable ignored) {}
        });
        host.logInfo("hooked WebViewClient#" + methodName + ": " + className);
    }

    private void hookWebChromeProgress(ClassLoader cl, Class<?> webView, String packageName) {
        try {
            Class<?> chromeClient = hookSupport.findClass("android.webkit.WebChromeClient", cl);
            if (chromeClient != null) {
                hookSpecificWebChromeProgress(chromeClient, webView, packageName);
            }
        } catch (Throwable ignored) {}
    }

    private void hookSpecificWebChromeProgress(Class<?> clientClass, Class<?> webView, String packageName) {
        if (clientClass == null) return;
        String className = clientClass.getName();
        String hookKey = packageName + ":" + className + ":onProgressChanged";
        if (!hookedWebChromeClientClasses.add(hookKey)) return;
        Method method = hookSupport.declaredMethod(clientClass, "onProgressChanged", webView, int.class);
        if (method == null) return;
        hookSupport.hookAfter(method, chain -> {
            try {
                List<Object> args = chain.getArgs();
                int progress = args.size() > 1 && args.get(1) instanceof Integer ? (Integer) args.get(1) : 0;
                if (args.size() > 0 && progress >= 70) {
                    scheduleWebViewTitleRead(args.get(0), packageName, progress >= 100 ? 80L : 500L);
                    if (progress >= 100) scheduleWebViewTitleRead(args.get(0), packageName, 900L);
                }
            } catch (Throwable ignored) {}
        });
        host.logInfo("hooked WebChromeClient#onProgressChanged: " + className);
    }
}
