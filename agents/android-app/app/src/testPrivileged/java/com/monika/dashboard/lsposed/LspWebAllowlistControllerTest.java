package com.monika.dashboard.lsposed;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Context;
import android.content.Intent;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.annotation.Config;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

@RunWith(AndroidJUnit4.class)
@Config(sdk = 35)
public class LspWebAllowlistControllerTest {
    private static final String MI_BROWSER = "com.android.browser";
    private static final String CHROME = "com.android.chrome";
    private static final String EDGE = "com.microsoft.emmx";
    private static final List<String> INSTALLED = Arrays.asList(MI_BROWSER, CHROME, EDGE, "com.monika.dashboard");

    private Application context;

    @Before
    public void clearPersistedState() {
        context = ApplicationProvider.getApplicationContext();
        context.createDeviceProtectedStorageContext()
                .getSharedPreferences("monika_lsp_web_allowlist", Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
    }

    @Test
    public void activeAllowlistPausesOtherBrowsersAndPushesStateToTheSystemBrowser() throws Exception {
        LspWebAllowlistTestHosts.FakeHost host = host();
        LspWebAllowlistController controller = new LspWebAllowlistController(host);

        controller.applyPolicy(alwaysOn("example.com"), System.currentTimeMillis());

        assertEquals(set(CHROME, EDGE), host.suspended);
        JSONObject status = controller.statusJson(System.currentTimeMillis());
        assertTrue(status.getBoolean("active"));
        assertEquals(MI_BROWSER, status.getString("browser_package"));
        assertEquals(1, status.getInt("allowed_domain_count"));
        assertEquals(2, status.getJSONArray("paused_browsers").length());

        Intent pushed = lastStatePush();
        assertEquals(MI_BROWSER, pushed.getPackage());
        JSONObject state = new JSONObject(pushed.getStringExtra(LspWebAllowlistController.EXTRA_STATE));
        assertEquals("example.com", state.getJSONArray("allowed_domains").getString(0));
    }

    @Test
    public void manualPauseReleasesBrowsersUntilResumed() throws Exception {
        LspWebAllowlistTestHosts.FakeHost host = host();
        LspWebAllowlistController controller = new LspWebAllowlistController(host);
        long now = System.currentTimeMillis();
        controller.applyPolicy(alwaysOn("example.com"), now);

        controller.pause(30, now);
        assertTrue(host.suspended.isEmpty());
        JSONObject paused = controller.statusJson(now);
        assertFalse(paused.getBoolean("active"));
        assertTrue(paused.getString("paused_until").length() > 0);

        controller.pause(0, now);
        assertEquals(set(CHROME, EDGE), host.suspended);
    }

    @Test
    public void pauseIsCappedAtOneHour() throws Exception {
        LspWebAllowlistTestHosts.FakeHost host = host();
        LspWebAllowlistController controller = new LspWebAllowlistController(host);
        long now = System.currentTimeMillis();
        controller.applyPolicy(alwaysOn("example.com"), now);

        controller.pause(24 * 60, now);

        assertTrue(controller.statusJson(now + 59 * 60_000L).getString("paused_until").length() > 0);
        assertTrue(controller.statusJson(now + 61 * 60_000L).getBoolean("active"));
    }

    @Test
    public void endingStrictBrowsingKeepsSupervisionFreezesInPlace() throws Exception {
        LspWebAllowlistTestHosts.FakeHost host = host();
        LspWebAllowlistController controller = new LspWebAllowlistController(host);
        controller.applyPolicy(alwaysOn("example.com"), System.currentTimeMillis());
        host.supervisionFrozen.add(CHROME);

        controller.applyPolicy(new JSONObject(), System.currentTimeMillis());

        assertEquals(set(CHROME), host.suspended);
        assertEquals(0, controller.statusJson(System.currentTimeMillis()).getJSONArray("paused_browsers").length());
    }

    @Test
    public void restartReleasesPersistedSuspensionsWhenSupervisionIsOff() throws Exception {
        LspWebAllowlistController first = new LspWebAllowlistController(host());
        first.applyPolicy(alwaysOn("example.com"), System.currentTimeMillis());

        LspWebAllowlistTestHosts.FakeHost restartedHost = host();
        restartedHost.suspended.addAll(set(CHROME, EDGE));
        LspWebAllowlistController restarted = new LspWebAllowlistController(restartedHost);
        restarted.restore(alwaysOn("example.com"));
        restarted.evaluate(System.currentTimeMillis(), "", false);

        assertTrue(restartedHost.suspended.isEmpty());
        assertFalse(restarted.statusJson(System.currentTimeMillis()).getBoolean("active"));
    }

    @Test
    public void switchingSupervisionOffOnThePhoneClearsTheBrowserState() throws Exception {
        LspWebAllowlistTestHosts.FakeHost host = host();
        LspWebAllowlistController controller = new LspWebAllowlistController(host);
        controller.applyPolicy(alwaysOn("example.com"), System.currentTimeMillis());

        controller.evaluate(System.currentTimeMillis(), "", false);

        assertTrue(host.suspended.isEmpty());
        JSONObject pushed = new JSONObject(lastStatePush().getStringExtra(LspWebAllowlistController.EXTRA_STATE));
        assertEquals(0, pushed.getJSONArray("allowed_domains").length());

        controller.evaluate(System.currentTimeMillis(), "", true);
        pushed = new JSONObject(lastStatePush().getStringExtra(LspWebAllowlistController.EXTRA_STATE));
        assertEquals("example.com", pushed.getJSONArray("allowed_domains").getString(0));
        assertEquals(set(CHROME, EDGE), host.suspended);
    }

    @Test
    public void phonesWithoutTheSystemBrowserNeverActivate() throws Exception {
        LspWebAllowlistTestHosts.FakeHost host = new LspWebAllowlistTestHosts.FakeHost(context, Arrays.asList(CHROME, EDGE));
        host.declaredBrowsers.addAll(Arrays.asList(CHROME, EDGE));
        LspWebAllowlistController controller = new LspWebAllowlistController(host);

        controller.applyPolicy(alwaysOn("example.com"), System.currentTimeMillis());

        assertFalse(controller.supported());
        assertTrue(host.suspended.isEmpty());
    }

    private LspWebAllowlistTestHosts.FakeHost host() {
        LspWebAllowlistTestHosts.FakeHost host = new LspWebAllowlistTestHosts.FakeHost(context, INSTALLED);
        host.declaredBrowsers.addAll(Arrays.asList(CHROME, MI_BROWSER, EDGE));
        return host;
    }

    private Intent lastStatePush() {
        List<Intent> intents = shadowOf(context).getBroadcastIntents();
        for (int i = intents.size() - 1; i >= 0; i--) {
            if (LspWebAllowlistController.ACTION_STATE.equals(intents.get(i).getAction())) return intents.get(i);
        }
        throw new AssertionError("no web allowlist state broadcast");
    }

    private static JSONObject alwaysOn(String domain) throws Exception {
        return new JSONObject()
                .put("allowed_domains", new JSONArray().put(domain))
                .put("active_windows", new JSONArray());
    }

    private static Set<String> set(String... values) {
        return new HashSet<>(Arrays.asList(values));
    }
}
