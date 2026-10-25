package com.monika.dashboard.lsposed;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.List;

@RunWith(AndroidJUnit4.class)
@Config(sdk = 35)
public class LspSupervisionPolicyPersistenceTest {
    private static final long NOW = 1_700_000_000_000L;
    private Context context;

    @Before
    public void clearStoredPolicy() {
        context = ApplicationProvider.getApplicationContext();
        context.createDeviceProtectedStorageContext()
                .getSharedPreferences(LspSupervisionPolicyStore.PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
    }

    @Test
    public void lastValidRiskPolicySurvivesRestartAndRequestsReviewWhileOffline() throws Exception {
        FakeHost initialHost = new FakeHost(context);
        LspSupervisionCoordinator initial = new LspSupervisionCoordinator(initialHost, LspWebAllowlistTestHosts.inactive(context));
        assertTrue(initial.applyPolicy(policy(
                new JSONArray().put("Video"),
                1,
                new JSONArray())));

        FakeHost restartedHost = new FakeHost(context);
        restartedHost.foregroundPackage = "com.example.video";
        restartedHost.foregroundApp = "Video";
        restartedHost.networkConnected = false;
        LspSupervisionCoordinator restarted = new LspSupervisionCoordinator(restartedHost, LspWebAllowlistTestHosts.inactive(context));
        assertTrue(restarted.restorePolicy());

        restarted.evaluate(NOW);
        assertEquals(0, restartedHost.frozenPackages.size());

        restarted.evaluate(NOW + 60_001L);
        assertTrue(restarted.shouldRequestReviewForReport());
        assertTrue(restartedHost.directUploadRequests > 0);
        assertTrue(restartedHost.frozenPackages.isEmpty());
    }

    @Test
    public void lastValidTimeLimitSurvivesRestartAndFreezesMatchedAppWhileOffline() throws Exception {
        FakeHost initialHost = new FakeHost(context);
        LspSupervisionCoordinator initial = new LspSupervisionCoordinator(initialHost, LspWebAllowlistTestHosts.inactive(context));
        assertTrue(initial.applyPolicy(policy(
                new JSONArray(),
                3,
                new JSONArray().put(limit("Game", 1, "daily limit")))));

        FakeHost restartedHost = new FakeHost(context);
        restartedHost.foregroundPackage = "com.example.game";
        restartedHost.foregroundApp = "Game";
        restartedHost.networkConnected = false;
        LspSupervisionCoordinator restarted = new LspSupervisionCoordinator(restartedHost, LspWebAllowlistTestHosts.inactive(context));
        assertTrue(restarted.restorePolicy());

        restarted.evaluate(NOW);
        restarted.evaluate(NOW + 60_001L);

        assertEquals(List.of("com.example.game"), restartedHost.frozenPackages);
    }

    @Test
    public void offlineStateAloneNeverFreezesAnAppOutsideTheRestoredPolicy() throws Exception {
        FakeHost initialHost = new FakeHost(context);
        LspSupervisionCoordinator initial = new LspSupervisionCoordinator(initialHost, LspWebAllowlistTestHosts.inactive(context));
        assertTrue(initial.applyPolicy(policy(
                new JSONArray().put("Video"),
                1,
                new JSONArray().put(limit("Game", 1, "daily limit")))));

        FakeHost restartedHost = new FakeHost(context);
        restartedHost.foregroundPackage = "com.example.notes";
        restartedHost.foregroundApp = "Notes";
        restartedHost.networkConnected = false;
        LspSupervisionCoordinator restarted = new LspSupervisionCoordinator(restartedHost, LspWebAllowlistTestHosts.inactive(context));
        assertTrue(restarted.restorePolicy());

        restarted.evaluate(NOW);
        restarted.evaluate(NOW + 10 * 60_000L);

        assertTrue(restartedHost.frozenPackages.isEmpty());
    }

    private static JSONObject policy(JSONArray risks, int riskMinutes, JSONArray limits) throws Exception {
        return new JSONObject()
                .put("risk_app_regex", risks)
                .put("risk_trigger_minutes", riskMinutes)
                .put("app_time_limits", limits);
    }

    private static JSONObject limit(String appRegex, int minutes, String reason) throws Exception {
        return new JSONObject()
                .put("app_regex", appRegex)
                .put("limit_minutes", minutes)
                .put("reason", reason);
    }

    private static final class FakeHost implements LspSupervisionCoordinator.Host {
        private final Context context;
        private final Handler handler = new Handler(Looper.getMainLooper());
        private final List<String> frozenPackages = new ArrayList<>();
        private String foregroundPackage = "";
        private String foregroundApp = "";
        private boolean networkConnected = true;
        private int directUploadRequests = 0;

        FakeHost(Context context) {
            this.context = context;
        }

        @Override
        public Context systemContext() {
            return context;
        }

        @Override
        public Handler uploadHandler() {
            return handler;
        }

        @Override
        public boolean enabled() {
            return true;
        }

        @Override
        public boolean uploadForeground() {
            return true;
        }

        @Override
        public boolean systemServerProcess() {
            return true;
        }

        @Override
        public boolean networkConnected() {
            return networkConnected;
        }

        @Override
        public String foregroundPackage() {
            return foregroundPackage;
        }

        @Override
        public String foregroundApp() {
            return foregroundApp;
        }

        @Override
        public String primaryDisplayTitle() {
            return "";
        }

        @Override
        public boolean protectedPackage(String packageName) {
            return false;
        }

        @Override
        public LspFreezeResult freezePackage(String packageName, String reason, long now, long until) {
            frozenPackages.add(packageName);
            return new LspFreezeResult(packageName, foregroundApp, "suspended", "applied", reason, until);
        }

        @Override
        public boolean clearFreeze(String reason) {
            frozenPackages.clear();
            return true;
        }

        @Override
        public void requestDirectUpload(boolean force) {
            directUploadRequests++;
        }

        @Override
        public void logDebug(String message) {}
    }
}
