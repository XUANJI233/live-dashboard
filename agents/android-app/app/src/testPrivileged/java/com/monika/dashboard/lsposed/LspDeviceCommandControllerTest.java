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

    @Test
    public void appliesScreenOffCommandWhenRequested() throws Exception {
        FakeHost host = new FakeHost();
        LspDeviceCommandController controller = new LspDeviceCommandController(host);

        controller.handleCommand(screenOffCommand(), "test");
        shadowOf(Looper.getMainLooper()).idle();

        assertEquals(1, host.screenOffCalls);
        JSONObject result = new JSONObject(host.wsBodies.get(1));
        assertEquals("applied", result.getString("status"));
        assertEquals("screen_off", result.getJSONArray("actions").getJSONObject(0).getString("action"));
        assertEquals("applied", result.getJSONArray("actions").getJSONObject(0).getString("status"));
    }

    @Test
    public void anchoredPackageFreezePatternMatchesInstalledPackageField() throws Exception {
        FakeHost host = new FakeHost();
        host.installedApps.add(new LspInstalledApp("com.ztgame.yyzy", "月圆之夜"));
        LspDeviceCommandController controller = new LspDeviceCommandController(host);

        controller.handleCommand(freezeCommand("^com\\.ztgame\\.yyzy$"), "test");
        shadowOf(Looper.getMainLooper()).idle();

        JSONObject result = new JSONObject(host.wsBodies.get(1));
        assertEquals("applied", result.getString("status"));
        assertEquals("com.ztgame.yyzy", host.freezeCalls.get(0));
    }

    @Test
    public void anchoredPackageUnfreezePatternMatchesFrozenPackageField() throws Exception {
        FakeHost host = new FakeHost();
        host.frozenApps.add(new LspFrozenPackage(
                "com.ztgame.yyzy", "月圆之夜", "suspended", "pending_supervision_review"));
        LspDeviceCommandController controller = new LspDeviceCommandController(host);

        controller.handleCommand(unfreezeCommand("^com\\.ztgame\\.yyzy$"), "test");
        shadowOf(Looper.getMainLooper()).idle();

        JSONObject result = new JSONObject(host.wsBodies.get(1));
        assertEquals("applied", result.getString("status"));
        assertEquals("com.ztgame.yyzy", host.unfreezeCalls.get(0));
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

    private static JSONObject screenOffCommand() throws Exception {
        return new JSONObject()
                .put("type", LspDeviceCommandProtocol.TYPE_COMMAND)
                .put("request_id", "req_screen")
                .put("command_id", "cmd_screen")
                .put("payload", new JSONObject()
                        .put("kind", LspDeviceCommandProtocol.KIND_SUPERVISION)
                        .put("screen_off", true));
    }

    private static JSONObject freezeCommand(String pattern) throws Exception {
        return new JSONObject()
                .put("type", LspDeviceCommandProtocol.TYPE_COMMAND)
                .put("request_id", "req_freeze")
                .put("command_id", "cmd_freeze")
                .put("payload", new JSONObject()
                        .put("kind", LspDeviceCommandProtocol.KIND_SUPERVISION)
                        .put("freeze_commands", new org.json.JSONArray().put(pattern)));
    }

    private static JSONObject unfreezeCommand(String pattern) throws Exception {
        return new JSONObject()
                .put("type", LspDeviceCommandProtocol.TYPE_COMMAND)
                .put("request_id", "req_unfreeze")
                .put("command_id", "cmd_unfreeze")
                .put("payload", new JSONObject()
                        .put("kind", LspDeviceCommandProtocol.KIND_SUPERVISION)
                        .put("unfreeze_commands", new org.json.JSONArray().put(pattern)));
    }

    private static final class FakeHost implements LspDeviceCommandHost {
        final Handler handler = new Handler(Looper.getMainLooper());
        final List<String> wsBodies = new ArrayList<>();
        final List<String> httpBodies = new ArrayList<>();
        final List<LspInstalledApp> installedApps = new ArrayList<>();
        final List<LspFrozenPackage> frozenApps = new ArrayList<>();
        final List<String> freezeCalls = new ArrayList<>();
        final List<String> unfreezeCalls = new ArrayList<>();
        int screenOffCalls = 0;

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
            return installedApps;
        }

        @Override
        public List<LspFrozenPackage> frozenPackages() {
            return frozenApps;
        }

        @Override
        public boolean unfreezePackage(String packageName) {
            unfreezeCalls.add(packageName);
            return true;
        }

        @Override
        public LspFreezeResult freezePackage(String packageName, String reason, long now, long until) {
            freezeCalls.add(packageName);
            return new LspFreezeResult(packageName, "月圆之夜", "suspended", "applied", reason, until);
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
        public boolean screenOff() {
            screenOffCalls++;
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
