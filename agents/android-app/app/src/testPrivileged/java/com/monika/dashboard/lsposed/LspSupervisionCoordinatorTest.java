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
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.annotation.Config;

@RunWith(AndroidJUnit4.class)
@Config(sdk = 35)
public class LspSupervisionCoordinatorTest {
    @Test
    public void riskThresholdRequestsAiReviewWithoutPreFreezing() throws Exception {
        FakeHost host = new FakeHost();
        LspSupervisionCoordinator coordinator = new LspSupervisionCoordinator(host);
        long startedAt = System.currentTimeMillis();

        coordinator.applyPolicy(new JSONObject()
                .put("risk_app_regex", new JSONArray().put("^com\\.example\\.game$"))
                .put("risk_trigger_minutes", 1)
                .put("app_time_limits", new JSONArray()));
        coordinator.evaluate(startedAt);
        coordinator.evaluate(startedAt + 61_000L);

        assertTrue(coordinator.shouldRequestReviewForReport());
        assertTrue(host.directUploadRequests > 0);
        assertEquals(0, host.freezeRequests);
    }

    private static final class FakeHost implements LspSupervisionCoordinator.Host {
        private final Context context = ApplicationProvider.getApplicationContext();
        private final Handler handler = new Handler(Looper.getMainLooper());
        int freezeRequests = 0;
        int directUploadRequests = 0;

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
            return true;
        }

        @Override
        public String foregroundPackage() {
            return "com.example.game";
        }

        @Override
        public String foregroundApp() {
            return "Example Game";
        }

        @Override
        public String primaryDisplayTitle() {
            return "Playing";
        }

        @Override
        public boolean protectedPackage(String packageName) {
            return false;
        }

        @Override
        public LspFreezeResult freezePackage(String packageName, String reason, long now, long until) {
            freezeRequests++;
            return new LspFreezeResult(packageName, "Example Game", "suspended", "applied", reason, until);
        }

        @Override
        public boolean clearFreeze(String reason) {
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
