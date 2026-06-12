package com.monika.dashboard.lsposed;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

@RunWith(AndroidJUnit4.class)
public class LspInstalledAppsReporterTest {
    private static final long REPORT_INTERVAL_MS = 6 * 60 * 60_000L;

    @Test
    public void heartbeatOnlyDoesNotScanInstalledApps() {
        FakeHost host = new FakeHost();
        LspInstalledAppsReporter reporter = new LspInstalledAppsReporter(host);

        reporter.putIfDue(new JSONObject(), 1_000L, true);

        assertEquals(0, host.calls);
    }

    @Test
    public void reportsSortedAppsOnlyWhenDueAndChanged() throws Exception {
        FakeHost host = new FakeHost();
        host.apps = Arrays.asList(
                new LspInstalledApp("com.example.beta", "Beta"),
                new LspInstalledApp("com.example.alpha", "Alpha"));
        LspInstalledAppsReporter reporter = new LspInstalledAppsReporter(host);

        JSONObject first = new JSONObject();
        reporter.putIfDue(first, 1_000L, false);

        JSONArray firstApps = first.getJSONArray("installed_apps");
        assertEquals("com.example.alpha", firstApps.getJSONObject(0).getString("package_name"));
        assertEquals("com.example.beta", firstApps.getJSONObject(1).getString("package_name"));
        assertEquals("t1000", first.getString("installed_apps_updated_at"));

        JSONObject tooSoon = new JSONObject();
        reporter.putIfDue(tooSoon, 2_000L, false);
        assertFalse(tooSoon.has("installed_apps"));

        host.apps = Arrays.asList(
                new LspInstalledApp("com.example.alpha", "Alpha"),
                new LspInstalledApp("com.example.beta", "Beta"));
        JSONObject sameContent = new JSONObject();
        reporter.putIfDue(sameContent, 1_000L + REPORT_INTERVAL_MS, false);
        assertFalse(sameContent.has("installed_apps"));

        host.apps = Arrays.asList(
                new LspInstalledApp("com.example.alpha", "Alpha"),
                new LspInstalledApp("com.example.beta", "Beta 2"));
        JSONObject changed = new JSONObject();
        reporter.putIfDue(changed, 1_000L + REPORT_INTERVAL_MS * 2, false);
        assertEquals("Beta 2", changed.getJSONArray("installed_apps").getJSONObject(1).getString("app_name"));
    }

    @Test
    public void failedScanDoesNotConsumeReportInterval() throws Exception {
        FakeHost host = new FakeHost();
        host.failNext = true;
        host.apps = Arrays.asList(new LspInstalledApp("com.example.alpha", "Alpha"));
        LspInstalledAppsReporter reporter = new LspInstalledAppsReporter(host);

        reporter.putIfDue(new JSONObject(), 1_000L, false);
        JSONObject retry = new JSONObject();
        reporter.putIfDue(retry, 1_001L, false);

        assertEquals(2, host.calls);
        assertEquals("com.example.alpha", retry.getJSONArray("installed_apps")
                .getJSONObject(0)
                .getString("package_name"));
    }

    private static final class FakeHost implements LspInstalledAppsReporter.Host {
        List<LspInstalledApp> apps = new ArrayList<>();
        boolean failNext = false;
        int calls = 0;

        @Override
        public List<LspInstalledApp> installedApps() {
            calls++;
            if (failNext) {
                failNext = false;
                throw new IllegalStateException("boom");
            }
            return apps;
        }

        @Override
        public String isoTime(long millis) {
            return "t" + millis;
        }

        @Override
        public void logWarn(String message) {}
    }
}
