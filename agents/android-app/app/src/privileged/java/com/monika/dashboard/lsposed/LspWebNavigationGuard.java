package com.monika.dashboard.lsposed;

import android.app.Application;
import android.app.BroadcastOptions;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.view.View;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.WeakHashMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Browser-process side of strict browsing in the system browser: top-level http(s)
 * navigations outside the allowlist pushed by system_server are replaced by a local
 * block page before they load. Covers HyperOS webkit (Mi Browser tabs) and android.webkit.
 */
final class LspWebNavigationGuard {
    interface Host {
        void logInfo(String message);
        void logWarn(String message);
        void logDebug(String message);
    }

    private static final String CACHE_FILE = "monika_web_allowlist.json";
    private static final long BLOCK_REPORT_INTERVAL_MS = 10_000L;
    // Mi Browser's address-bar suggestion panel is itself a WebView; clicking a suggestion still navigates the tab.
    private static final Set<String> BROWSER_UI_HOSTS = Collections.singleton("sug.browser.miui.com");
    private static final String[][] WEBKIT_FAMILIES = {
            {"hyper.webkit.WebView", "hyper.webkit.WebViewClient", "hyper.webkit.WebResourceRequest"},
            {"android.webkit.WebView", "android.webkit.WebViewClient", "android.webkit.WebResourceRequest"},
    };

    private final LspHookSupport hookSupport;
    private final Host host;
    private final Set<String> hookedClientClasses = ConcurrentHashMap.newKeySet();
    private final Set<View> openWebViews = Collections.newSetFromMap(new WeakHashMap<>());
    private volatile LspWebAllowlistState state = LspWebAllowlistState.empty();
    private volatile Context appContext;
    private volatile String lastReportedHost = "";
    private volatile long lastReportedAt = 0L;

    LspWebNavigationGuard(LspHookSupport hookSupport, Host host) {
        this.hookSupport = hookSupport;
        this.host = host;
    }

    void install(ClassLoader cl, String packageName) {
        if (!LspWebAllowlistController.isSystemBrowser(packageName)) return;
        hookApplicationCreate(cl);
        int families = 0;
        for (String[] family : WEBKIT_FAMILIES) {
            if (installFamily(cl, family[0], family[1], family[2])) families++;
        }
        host.logInfo("installed web allowlist guard for " + packageName + " (" + families + " webkit families)");
    }

    private void hookApplicationCreate(ClassLoader cl) {
        Class<?> instrumentation = hookSupport.findClass("android.app.Instrumentation", cl);
        Method method = hookSupport.declaredMethod(instrumentation, "callApplicationOnCreate", Application.class);
        hookSupport.hookAfter(method, chain -> {
            Object app = chain.getArgs().isEmpty() ? null : chain.getArg(0);
            if (app instanceof Context) initialize((Context) app);
        });
    }

    private boolean installFamily(ClassLoader cl, String webViewName, String clientName, String requestName) {
        Class<?> webView = hookSupport.findClass(webViewName, cl);
        Class<?> client = hookSupport.findClass(clientName, cl);
        if (webView == null || client == null) return false;
        Class<?> request = hookSupport.findClass(requestName, cl);
        hookNavigationCall(hookSupport.declaredMethod(webView, "loadUrl", String.class));
        hookNavigationCall(hookSupport.declaredMethod(webView, "loadUrl", String.class, Map.class));
        hookNavigationCall(hookSupport.declaredMethod(webView, "postUrl", String.class, byte[].class));
        hookClientHierarchy(client, webView, request);
        hookSupport.hookAfter(hookSupport.declaredMethod(webView, "setWebViewClient", client), chain -> {
            Object installed = chain.getArgs().isEmpty() ? null : chain.getArg(0);
            if (installed != null) hookClientHierarchy(installed.getClass(), webView, request);
        });
        return true;
    }

    /** loadUrl/postUrl: swap a blocked address for the block page before the original call. */
    private void hookNavigationCall(Method method) {
        hookSupport.hookIntercept(method, chain -> {
            track(chain.getThisObject());
            List<Object> args = chain.getArgs();
            Object url = args.isEmpty() ? null : args.get(0);
            if (url instanceof String && shouldBlock((String) url)) {
                reportBlocked((String) url);
                Object[] replaced = args.toArray();
                replaced[0] = blockPage((String) url);
                return chain.proceed(replaced);
            }
            return chain.proceed();
        });
    }

    private void hookClientHierarchy(Class<?> clientClass, Class<?> webView, Class<?> request) {
        for (Class<?> current = clientClass; current != null && current != Object.class; current = current.getSuperclass()) {
            String key = current.getName() + "@" + System.identityHashCode(current.getClassLoader());
            if (!hookedClientClasses.add(key)) continue;
            hookOverride(hookSupport.declaredMethod(current, "shouldOverrideUrlLoading", webView, String.class), false);
            if (request != null) {
                hookOverride(hookSupport.declaredMethod(current, "shouldOverrideUrlLoading", webView, request), true);
            }
            hookPageStarted(hookSupport.declaredMethod(
                    current, "onPageStarted", webView, String.class, android.graphics.Bitmap.class));
        }
    }

    /** Link clicks and redirects: cancel a blocked main-frame navigation and show the block page. */
    private void hookOverride(Method method, boolean requestVariant) {
        hookSupport.hookIntercept(method, chain -> {
            List<Object> args = chain.getArgs();
            Object view = args.size() > 0 ? args.get(0) : null;
            Object target = args.size() > 1 ? args.get(1) : null;
            String url = requestVariant ? requestUrl(target) : (target instanceof String ? (String) target : "");
            boolean mainFrame = !requestVariant || isMainFrame(target);
            if (mainFrame && shouldBlock(url)) {
                reportBlocked(url);
                showBlockPage(view, url);
                return Boolean.TRUE;
            }
            return chain.proceed();
        });
    }

    /** Safety net for navigations that reach the page without passing the hooks above. */
    private void hookPageStarted(Method method) {
        hookSupport.hookIntercept(method, chain -> {
            Object result = chain.proceed();
            List<Object> args = chain.getArgs();
            Object view = args.size() > 0 ? args.get(0) : null;
            Object url = args.size() > 1 ? args.get(1) : null;
            track(view);
            if (url instanceof String && shouldBlock((String) url)) {
                reportBlocked((String) url);
                hookSupport.invokeNoArg(view, "stopLoading");
                showBlockPage(view, (String) url);
            }
            return result;
        });
    }

    private boolean shouldBlock(String url) {
        if (url == null || url.length() == 0) return false;
        if (BROWSER_UI_HOSTS.contains(LspWebAllowlistState.hostOf(url))) return false;
        if (appContext == null) initialize(currentApplication());
        LspWebAllowlistState current = state;
        return current.activeAt(System.currentTimeMillis(), TimeZone.getDefault()) && !current.allowsUrl(url);
    }

    private void showBlockPage(Object view, String url) {
        if (!(view instanceof View)) return;
        String page = blockPage(url);
        ((View) view).post(() -> {
            try {
                Method load = hookSupport.publicMethod(view.getClass(), "loadUrl", String.class);
                if (load != null) load.invoke(view, page);
            } catch (Throwable t) {
                host.logDebug("web allowlist block page failed: " + t.getClass().getSimpleName());
            }
        });
    }

    private synchronized void initialize(Context context) {
        if (appContext != null || context == null) return;
        Context app = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        appContext = app;
        loadCache(app);
        try {
            BroadcastReceiver receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context receiverContext, Intent intent) {
                    acceptState(intent);
                }
            };
            IntentFilter filter = new IntentFilter(LspWebAllowlistController.ACTION_STATE);
            // Not exported: only system_server (system UID) and this app can deliver state.
            if (Build.VERSION.SDK_INT >= 33) {
                app.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                app.registerReceiver(receiver, filter);
            }
        } catch (Throwable t) {
            host.logWarn("web allowlist state receiver failed: " + t.getClass().getSimpleName());
        }
        sendEvent(LspWebAllowlistController.EVENT_REQUEST, "");
    }

    private void acceptState(Intent intent) {
        if (intent == null || !LspWebAllowlistController.ACTION_STATE.equals(intent.getAction())) return;
        try {
            String raw = intent.getStringExtra(LspWebAllowlistController.EXTRA_STATE);
            if (raw == null || raw.length() == 0) return;
            state = LspWebAllowlistState.fromStateJson(new JSONObject(raw));
            writeCache(raw);
            if (state.activeAt(System.currentTimeMillis(), TimeZone.getDefault())) blockOpenPages();
        } catch (Throwable t) {
            host.logDebug("web allowlist state rejected: " + t.getClass().getSimpleName());
        }
    }

    private void track(Object view) {
        if (!(view instanceof View)) return;
        synchronized (openWebViews) {
            openWebViews.add((View) view);
        }
    }

    /** A page opened during a pause or outside the window must not stay usable once blocking resumes. */
    private void blockOpenPages() {
        List<View> views;
        synchronized (openWebViews) {
            views = new ArrayList<>(openWebViews);
        }
        for (View view : views) {
            view.post(() -> {
                Object url = hookSupport.invokeNoArg(view, "getUrl");
                if (url instanceof String && shouldBlock((String) url)) showBlockPage(view, (String) url);
            });
        }
    }

    private void reportBlocked(String url) {
        String blockedHost = LspWebAllowlistState.hostOf(url);
        long now = System.currentTimeMillis();
        if (blockedHost.equals(lastReportedHost) && now - lastReportedAt < BLOCK_REPORT_INTERVAL_MS) return;
        lastReportedHost = blockedHost;
        lastReportedAt = now;
        sendEvent(LspWebAllowlistController.EVENT_BLOCKED, blockedHost);
    }

    private void sendEvent(String event, String blockedHost) {
        Context context = appContext;
        if (context == null) return;
        try {
            Intent intent = new Intent(LspWebAllowlistController.ACTION_EVENT);
            // Delivered to system_server only, so blocked hosts never reach other apps.
            intent.setPackage("android");
            intent.putExtra(LspWebAllowlistController.EXTRA_EVENT, event);
            if (blockedHost.length() > 0) intent.putExtra(LspWebAllowlistController.EXTRA_HOST, blockedHost);
            if (Build.VERSION.SDK_INT >= 34) {
                BroadcastOptions options = BroadcastOptions.makeBasic();
                options.setShareIdentityEnabled(true);
                context.sendBroadcast(intent, null, options.toBundle());
            } else {
                context.sendBroadcast(intent);
            }
        } catch (Throwable t) {
            host.logDebug("web allowlist event failed: " + t.getClass().getSimpleName());
        }
    }

    private void loadCache(Context context) {
        try {
            File file = new File(context.getFilesDir(), CACHE_FILE);
            if (!file.isFile() || file.length() > 32 * 1024) return;
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            try (FileInputStream input = new FileInputStream(file)) {
                byte[] chunk = new byte[4096];
                int read;
                while ((read = input.read(chunk)) > 0) buffer.write(chunk, 0, read);
            }
            state = LspWebAllowlistState.fromStateJson(new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8)));
        } catch (Throwable t) {
            host.logDebug("web allowlist cache unreadable: " + t.getClass().getSimpleName());
        }
    }

    private void writeCache(String raw) {
        Context context = appContext;
        if (context == null) return;
        try (FileOutputStream output = new FileOutputStream(new File(context.getFilesDir(), CACHE_FILE))) {
            output.write(raw.getBytes(StandardCharsets.UTF_8));
        } catch (Throwable t) {
            host.logDebug("web allowlist cache write failed: " + t.getClass().getSimpleName());
        }
    }

    private String requestUrl(Object request) {
        Object url = hookSupport.invokeNoArg(request, "getUrl");
        return url != null ? url.toString() : "";
    }

    private boolean isMainFrame(Object request) {
        Object mainFrame = hookSupport.invokeNoArg(request, "isForMainFrame");
        return !(mainFrame instanceof Boolean) || (Boolean) mainFrame;
    }

    private static Context currentApplication() {
        try {
            Object app = Class.forName("android.app.ActivityThread").getMethod("currentApplication").invoke(null);
            return app instanceof Context ? (Context) app : null;
        } catch (Throwable ignored) {
            return null;
        }
    }

    static String blockPage(String url) {
        String host = escapeHtml(LspWebAllowlistState.hostOf(url));
        String html = "<!doctype html><html><head><meta charset=utf-8>"
                + "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>已拦截</title></head>"
                + "<body style=\"font-family:sans-serif;margin:0;padding:48px 24px;color:#1f2328;background:#fff\">"
                + "<h2 style=\"margin:0 0 12px\">这个网站不在白名单里</h2>"
                + "<p style=\"color:#57606a;word-break:break-all\">" + host + "</p>"
                + "<p>监督时段内只能打开白名单网站。</p></body></html>";
        try {
            return "data:text/html;charset=utf-8," + URLEncoder.encode(html, "UTF-8").replace("+", "%20");
        } catch (Throwable ignored) {
            return "about:blank";
        }
    }

    private static String escapeHtml(String value) {
        return value
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&#39;");
    }
}
