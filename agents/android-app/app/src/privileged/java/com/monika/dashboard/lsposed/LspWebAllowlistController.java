package com.monika.dashboard.lsposed;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TimeZone;

/**
 * system_server side of strict browsing: while the controller-authored allowlist is
 * active, other browsers stay suspended and the system browser receives the state its
 * navigation guard enforces. Suspensions here are tracked apart from supervision
 * freezes, so "unfreeze all" and the daily reset never release them.
 */
final class LspWebAllowlistController {
    interface Host {
        Context systemContext();
        Handler handler();
        List<String> browserPackages();
        boolean isInstalled(String packageName);
        boolean setPackageSuspended(String packageName, boolean suspended);
        boolean isSupervisionFrozen(String packageName);
        void requestDirectUpload(boolean force);
        String isoTime(long millis);
        void logDebug(String message);
        void logWarn(String message);
    }

    static final String[] SYSTEM_BROWSERS = {"com.android.browser", "com.mi.globalbrowser", "com.mi.browser"};
    static final String ACTION_STATE = "com.monika.dashboard.LSPOSED_WEB_ALLOWLIST_STATE";
    static final String ACTION_EVENT = "com.monika.dashboard.LSPOSED_WEB_ALLOWLIST_EVENT";
    static final String EXTRA_STATE = "state";
    static final String EXTRA_EVENT = "event";
    static final String EXTRA_HOST = "host";
    static final String EVENT_REQUEST = "request";
    static final String EVENT_BLOCKED = "blocked";

    static final String STATE_FILE = "web_allowlist_state.json";
    private static final String KEY_PAUSED_UNTIL = "paused_until_ms";
    private static final String KEY_SUSPENDED = "suspended_browsers";
    // Repair suspensions an "unfreeze all" may have lifted, without querying on every foreground change.
    private static final long ENFORCE_REPAIR_MS = 5 * 60_000L;
    private static final long MAX_SCHEDULE_DELAY_MS = 6 * 60 * 60_000L;

    private final Host host;
    private final Set<String> suspendedBrowsers = new LinkedHashSet<>();
    private volatile LspWebAllowlistState state = LspWebAllowlistState.empty();
    private volatile boolean lastActive = false;
    private volatile boolean lastEnabled = true;
    private volatile long lastEnforcedAt = 0L;
    private volatile String lastPushedSignature = "";
    private volatile String lastForegroundPackage = "";
    private volatile String lastBlockedHost = "";
    private volatile long lastBlockedAt = 0L;
    private volatile long evaluationDueAt = 0L;
    private volatile boolean receiverRegistered = false;

    LspWebAllowlistController(Host host) {
        this.host = host;
    }

    /** Restore the persisted policy, pause, and suspension records after a reboot. */
    synchronized void restore(JSONObject policy) {
        JSONObject saved = readSavedState();
        state = LspWebAllowlistState.fromPolicy(policy, saved.optLong(KEY_PAUSED_UNTIL, 0L));
        JSONArray suspended = saved.optJSONArray(KEY_SUSPENDED);
        for (int i = 0; suspended != null && i < suspended.length(); i++) {
            String pkg = safeString(suspended.optString(i, ""));
            if (pkg.length() > 0) suspendedBrowsers.add(pkg);
        }
        host.logWarn("web allowlist restored: " + state.domains.size() + " domains, "
                + suspendedBrowsers.size() + " paused browsers");
    }

    void applyPolicy(JSONObject policy, long now) {
        synchronized (this) {
            state = LspWebAllowlistState.fromPolicy(policy, state.pausedUntilMs);
        }
        evaluate(now, lastForegroundPackage, lastEnabled);
    }

    JSONObject policyJson() {
        return state.policyJson();
    }

    /** Manual pause from the app; minutes <= 0 resumes immediately. */
    void pause(int minutes, long now) {
        long until = minutes <= 0 ? 0L : now + Math.min(minutes * 60_000L, LspWebAllowlistState.MAX_PAUSE_MS);
        synchronized (this) {
            state = state.withPausedUntil(until);
        }
        persistState();
        host.logWarn(until > 0 ? "web allowlist paused for " + minutes + " min" : "web allowlist resumed");
        evaluate(now, lastForegroundPackage, lastEnabled);
        host.requestDirectUpload(true);
    }

    boolean supported() {
        return sanctionedBrowser().length() > 0;
    }

    /** enabled=false (LSP supervision switched off) treats the allowlist as inactive. */
    synchronized void evaluate(long now, String foregroundPackage, boolean enabled) {
        try {
            lastEnabled = enabled;
            String browser = sanctionedBrowser();
            boolean active = enabled && browser.length() > 0 && state.activeAt(now, TimeZone.getDefault());
            boolean changed = active != lastActive;
            if (active && (changed || now - lastEnforcedAt >= ENFORCE_REPAIR_MS)) {
                suspendOtherBrowsers(browser);
                lastEnforcedAt = now;
            } else if (!active && !suspendedBrowsers.isEmpty()) {
                releaseBrowsers();
            }
            lastActive = active;
            String foreground = foregroundPackage == null ? "" : foregroundPackage;
            boolean browserCameForward = browser.length() > 0
                    && browser.equals(foreground)
                    && !browser.equals(lastForegroundPackage);
            lastForegroundPackage = foreground;
            LspWebAllowlistState pushed = pushedState();
            if (browser.length() > 0 && (browserCameForward || !pushed.signature().equals(lastPushedSignature))) {
                pushState(browser, pushed);
            }
            if (changed) host.requestDirectUpload(true);
            scheduleEvaluation(now);
        } catch (Throwable t) {
            host.logDebug("web allowlist evaluate skipped: " + t.getClass().getSimpleName());
        }
    }

    JSONObject statusJson(long now) {
        JSONObject status = new JSONObject();
        LspWebAllowlistState current = state;
        LspDeviceCommandProtocol.put(status, "active", lastEnabled
                && sanctionedBrowser().length() > 0
                && current.activeAt(now, TimeZone.getDefault()));
        LspDeviceCommandProtocol.put(status, "paused_until",
                current.pausedAt(now) ? host.isoTime(current.pausedUntilMs) : "");
        LspDeviceCommandProtocol.put(status, "browser_package", sanctionedBrowser());
        LspDeviceCommandProtocol.put(status, "allowed_domain_count", current.domains.size());
        synchronized (this) {
            LspDeviceCommandProtocol.put(status, "paused_browsers", new JSONArray(new ArrayList<>(suspendedBrowsers)));
        }
        LspDeviceCommandProtocol.put(status, "last_blocked_host", lastBlockedHost);
        LspDeviceCommandProtocol.put(status, "last_blocked_at", lastBlockedAt > 0 ? host.isoTime(lastBlockedAt) : "");
        return status;
    }

    /** Events from the system browser: state requests and blocked navigations. */
    void registerReceiver(Handler handler) {
        if (receiverRegistered) return;
        Context context = host.systemContext();
        if (context == null) return;
        try {
            BroadcastReceiver receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context receiverContext, Intent intent) {
                    handleEvent(this, intent);
                }
            };
            ContextCompat.registerReceiver(
                    context,
                    receiver,
                    new IntentFilter(ACTION_EVENT),
                    null,
                    handler,
                    ContextCompat.RECEIVER_EXPORTED);
            receiverRegistered = true;
        } catch (Throwable t) {
            host.logWarn("web allowlist receiver failed: " + t.getClass().getSimpleName());
        }
    }

    private void handleEvent(BroadcastReceiver receiver, Intent intent) {
        if (intent == null || !ACTION_EVENT.equals(intent.getAction())) return;
        String browser = sanctionedBrowser();
        // Only the system browser may report; Android 14+ shares the verified sender package.
        if (browser.length() == 0 || Build.VERSION.SDK_INT < 34 || !browser.equals(receiver.getSentFromPackage())) {
            host.logDebug("web allowlist event ignored: unverified sender");
            return;
        }
        String event = safeString(intent.getStringExtra(EXTRA_EVENT));
        if (EVENT_REQUEST.equals(event)) {
            pushState(browser, pushedState());
        } else if (EVENT_BLOCKED.equals(event)) {
            String blockedHost = LspWebAllowlistState.normalizeDomain(intent.getStringExtra(EXTRA_HOST));
            if (blockedHost.length() == 0) return;
            lastBlockedHost = blockedHost;
            lastBlockedAt = System.currentTimeMillis();
            host.requestDirectUpload(false);
        }
    }

    private void suspendOtherBrowsers(String sanctioned) {
        LinkedHashSet<String> targets = new LinkedHashSet<>(host.browserPackages());
        for (String known : LspBrowserTitle.knownBrowserPackages()) {
            if (host.isInstalled(known)) targets.add(known);
        }
        boolean changed = false;
        for (String pkg : targets) {
            if (pkg.equals(sanctioned) || isSystemBrowser(pkg)) continue;
            if (host.setPackageSuspended(pkg, true)) {
                synchronized (this) {
                    changed |= suspendedBrowsers.add(pkg);
                }
            }
        }
        if (changed) persistState();
    }

    private void releaseBrowsers() {
        List<String> release;
        synchronized (this) {
            release = new ArrayList<>(suspendedBrowsers);
        }
        boolean changed = false;
        for (String pkg : release) {
            // A supervision freeze of the same app outlives the strict-browsing window.
            if (host.isSupervisionFrozen(pkg) || host.setPackageSuspended(pkg, false) || !host.isInstalled(pkg)) {
                synchronized (this) {
                    changed |= suspendedBrowsers.remove(pkg);
                }
            }
        }
        if (changed) persistState();
    }

    /** The browser enforces nothing while LSP supervision is switched off on the phone. */
    private LspWebAllowlistState pushedState() {
        return lastEnabled ? state : LspWebAllowlistState.empty();
    }

    private void pushState(String browser, LspWebAllowlistState pushed) {
        Context context = host.systemContext();
        if (context == null) return;
        Intent intent = new Intent(ACTION_STATE);
        intent.setPackage(browser);
        intent.putExtra(EXTRA_STATE, pushed.stateJson().toString());
        long token = Binder.clearCallingIdentity();
        try {
            context.sendBroadcast(intent);
            lastPushedSignature = pushed.signature();
        } catch (Throwable t) {
            host.logDebug("web allowlist push failed: " + t.getClass().getSimpleName());
        } finally {
            Binder.restoreCallingIdentity(token);
        }
    }

    private void scheduleEvaluation(long now) {
        Handler handler = host.handler();
        if (handler == null) return;
        long next = state.nextChangeAfter(now, TimeZone.getDefault());
        if (next == Long.MAX_VALUE) return;
        long delay = Math.min(MAX_SCHEDULE_DELAY_MS, Math.max(1000L, next - now + 500L));
        long dueAt = now + delay;
        long currentDue = evaluationDueAt;
        if (currentDue > now && currentDue <= dueAt) return;
        evaluationDueAt = dueAt;
        handler.postDelayed(() -> {
            if (System.currentTimeMillis() + 500L < evaluationDueAt) return;
            evaluationDueAt = 0L;
            evaluate(System.currentTimeMillis(), lastForegroundPackage, lastEnabled);
        }, delay);
    }

    String sanctionedBrowser() {
        for (String pkg : SYSTEM_BROWSERS) {
            if (host.isInstalled(pkg)) return pkg;
        }
        return "";
    }

    static boolean isSystemBrowser(String packageName) {
        for (String pkg : SYSTEM_BROWSERS) {
            if (pkg.equals(packageName)) return true;
        }
        return false;
    }

    /** Pause and strict-browsing suspensions, so a reboot mid-window still releases browsers. */
    private void persistState() {
        Context context = host.systemContext();
        if (context == null) return;
        JSONObject saved = new JSONObject();
        synchronized (this) {
            LspDeviceCommandProtocol.put(saved, KEY_PAUSED_UNTIL, state.pausedUntilMs);
            LspDeviceCommandProtocol.put(saved, KEY_SUSPENDED, new JSONArray(new ArrayList<>(suspendedBrowsers)));
        }
        try {
            LspSystemStateFile.write(context, STATE_FILE, saved.toString());
        } catch (Throwable t) {
            host.logWarn("web allowlist state not saved: " + t.getClass().getSimpleName());
        }
    }

    private JSONObject readSavedState() {
        Context context = host.systemContext();
        if (context == null) return new JSONObject();
        try {
            String raw = LspSystemStateFile.read(context, STATE_FILE);
            return raw.length() > 0 ? new JSONObject(raw) : new JSONObject();
        } catch (Throwable t) {
            host.logWarn("web allowlist state unreadable: " + t.getClass().getSimpleName());
            return new JSONObject();
        }
    }

    private static String safeString(String value) {
        return value == null ? "" : value.trim();
    }
}
