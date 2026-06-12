package com.monika.dashboard.lsposed;

import static org.junit.Assert.assertEquals;
import static org.robolectric.Shadows.shadowOf;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.annotation.Config;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@RunWith(AndroidJUnit4.class)
@Config(sdk = 35)
public class LspDeviceCommandControllerTest {
    @Test
    public void wsSubmittedEventsFallbackToHttpWhenServerAckIsMissing() throws Exception {
        FakeHost host = new FakeHost();
        LspDeviceCommandController controller = new LspDeviceCommandController(host);

        controller.handleCommand(command(), "test");
        shadowOf(Looper.getMainLooper()).idle();

        assertEquals(2, host.wsBodies.size());
        assertEquals(0, host.httpBodies.size());

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(3_999L));
        assertEquals(0, host.httpBodies.size());

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1L));
        assertEquals(2, host.httpBodies.size());
    }

    private static JSONObject command() throws Exception {
        return new JSONObject()
                .put("type", LspDeviceCommandProtocol.TYPE_COMMAND)
                .put("request_id", "req_1")
                .put("command_id", "cmd_1")
                .put("payload", new JSONObject()
                        .put("kind", LspDeviceCommandProtocol.KIND_SUPERVISION)
                        .put("say", "hello"));
    }

    private static final class FakeHost implements LspDeviceCommandHost {
        final Handler handler = new Handler(Looper.getMainLooper());
        final List<String> wsBodies = new ArrayList<>();
        final List<String> httpBodies = new ArrayList<>();

        @Override
        public Handler uploadHandler() {
            return handler;
        }

        @Override
        public String directServerUrl() {
            return "https://example.test";
        }

        @Override
        public String directToken() {
            return "token";
        }

        @Override
        public void ensureWsConnected(String serverUrl, String token) {}

        @Override
        public boolean sendWsText(String text) {
            wsBodies.add(text);
            return true;
        }

        @Override
        public boolean postAckHttp(String serverUrl, String token, String body) {
            httpBodies.add(body);
            return true;
        }

        @Override
        public void logDebug(String message) {}

        @Override
        public String isoTime(long millis) {
            return "2026-06-12T00:00:00.000Z";
        }

        @Override
        public long nextDailyUnfreezeAt(long now) {
            return now + 60_000L;
        }

        @Override
        public JSONObject frozenState(long now) {
            return new JSONObject();
        }

        @Override
        public String foregroundPackage() {
            return "";
        }

        @Override
        public String foregroundApp() {
            return "";
        }

        @Override
        public String foregroundTitle() {
            return "";
        }

        @Override
        public boolean isInstalledPackage(String packageName) {
            return false;
        }

        @Override
        public List<LspInstalledApp> installedApps() {
            return Collections.emptyList();
        }

        @Override
        public List<LspFrozenPackage> frozenPackages() {
            return Collections.emptyList();
        }

        @Override
        public boolean unfreezePackage(String packageName) {
            return false;
        }

        @Override
        public LspFreezeResult freezePackage(String packageName, String reason, long now, long until) {
            return new LspFreezeResult(packageName, "", "", "ignored", "test", 0L);
        }

        @Override
        public boolean postSayNotification(String commandId, String text) {
            return true;
        }

        @Override
        public boolean vibrate(long durationMs) {
            return true;
        }

        @Override
        public void requestDirectUpload() {}

        @Override
        public boolean applySupervisionPolicy(JSONObject payload) {
            return true;
        }

        @Override
        public void finishPendingSupervisionReview() {}
    }
}
