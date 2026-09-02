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
import java.util.concurrent.Executor;

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

    @Test
    public void capturesAndUploadsScreenshotCommands() throws Exception {
        FakeHost host = new FakeHost();
        LspDeviceCommandController controller = new LspDeviceCommandController(host, Runnable::run);

        controller.handleCommand(screenshotCommand(), "test");
        shadowOf(Looper.getMainLooper()).idle();

        JSONObject result = new JSONObject(host.wsBodies.get(1));
        assertEquals("applied", result.getString("status"));
        assertEquals(1, host.screenshotCalls);
        assertEquals("screenshot", result.getJSONArray("actions").getJSONObject(0).getString("action"));
        assertEquals("shot_12345678-1234-1234-1234-123456789abc",
                result.getJSONArray("actions").getJSONObject(0).getString("screenshot_id"));
    }

    @Test
    public void screenshotWorkDoesNotBlockTheUploadHandler() throws Exception {
        FakeHost host = new FakeHost();
        DeferredExecutor screenshotExecutor = new DeferredExecutor();
        LspDeviceCommandController controller = new LspDeviceCommandController(host, screenshotExecutor);

        controller.handleCommand(screenshotCommand(), "test");
        controller.handleCommand(screenOffCommand(), "test");
        shadowOf(Looper.getMainLooper()).idle();

        assertEquals(1, host.screenOffCalls);
        assertEquals(0, host.screenshotCalls);

        screenshotExecutor.runPending();
        shadowOf(Looper.getMainLooper()).idle();
        assertEquals(1, host.screenshotCalls);
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

    private static JSONObject screenshotCommand() throws Exception {
        return new JSONObject()
                .put("type", LspDeviceCommandProtocol.TYPE_COMMAND)
                .put("request_id", "req_screenshot")
                .put("command_id", "cmd_screenshot")
                .put("payload", new JSONObject()
                        .put("kind", "screenshot")
                        .put("screenshot", new JSONObject()
                                .put("screenshot_id", "shot_12345678-1234-1234-1234-123456789abc")
                                .put("max_width", 720)
                                .put("jpeg_quality", 65)));
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
        int screenshotCalls = 0;

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
        public LspScreenshotResult captureAndUploadScreenshot(
                String commandId,
                String screenshotId,
                int maxWidth,
                int jpegQuality) {
            screenshotCalls++;
            return new LspScreenshotResult("applied", "", screenshotId, 720, 1600, 4);
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

    private static final class DeferredExecutor implements Executor {
        private Runnable pending;

        @Override
        public void execute(Runnable command) {
            pending = command;
        }

        void runPending() {
            Runnable command = pending;
            pending = null;
            if (command != null) command.run();
        }
    }
}
