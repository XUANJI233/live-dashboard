package com.monika.dashboard.lsposed;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.annotation.Config;

import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.TimeZone;

@RunWith(AndroidJUnit4.class)
@Config(sdk = 35)
public class LspWebAllowlistStateTest {
    private static final ZoneId SHANGHAI = ZoneId.of("Asia/Shanghai");
    private static final TimeZone TZ = TimeZone.getTimeZone(SHANGHAI);

    @Test
    public void allowsListedDomainsAndSubdomainsButNotLookalikes() throws Exception {
        LspWebAllowlistState state = LspWebAllowlistState.fromPolicy(policy(new JSONArray()), 0L);

        assertEquals("docs.example.com", LspWebAllowlistState.hostOf("https://User@Docs.Example.com:8443/path?q=1"));
        assertTrue(state.allowsUrl("https://example.com/"));
        assertTrue(state.allowsUrl("HTTPS://DOCS.EXAMPLE.COM/guide"));
        assertTrue(state.allowsUrl("https://zh.wikipedia.org/wiki/Matrix"));
        assertFalse(state.allowsUrl("https://badexample.com/"));
        assertFalse(state.allowsUrl("http://example.com.evil.net/"));
        assertFalse(state.allowsUrl("https://www.bilibili.com/"));
        // Internal, data, and script pages are never filtered.
        assertTrue(state.allowsUrl("about:blank"));
        assertTrue(state.allowsUrl(LspWebNavigationGuard.blockPage("https://www.bilibili.com/")));
        assertTrue(state.allowsUrl("javascript:void(0)"));
    }

    @Test
    public void appliesOnlyInsideWeekdayWindowsAndFindsTheNextChange() throws Exception {
        LspWebAllowlistState state = LspWebAllowlistState.fromPolicy(policy(new JSONArray()
                .put(new JSONObject()
                        .put("days", new JSONArray().put(1).put(2).put(3).put(4).put(5))
                        .put("start", "08:00")
                        .put("end", "12:00"))), 0L);

        assertTrue(state.activeAt(at(2026, 10, 26, 9, 0), TZ));
        assertFalse(state.activeAt(at(2026, 10, 26, 12, 0), TZ));
        assertFalse(state.activeAt(at(2026, 10, 31, 9, 0), TZ));

        assertEquals(at(2026, 10, 26, 8, 0), state.nextChangeAfter(at(2026, 10, 26, 7, 0), TZ));
        assertEquals(at(2026, 10, 26, 12, 0), state.nextChangeAfter(at(2026, 10, 26, 9, 0), TZ));
        assertEquals(at(2026, 11, 2, 8, 0), state.nextChangeAfter(at(2026, 10, 30, 13, 0), TZ));
    }

    @Test
    public void manualPauseOverridesTheScheduleUntilItEnds() throws Exception {
        long now = at(2026, 10, 26, 9, 0);
        LspWebAllowlistState state = LspWebAllowlistState.fromPolicy(policy(new JSONArray()), 0L)
                .withPausedUntil(now + 30 * 60_000L);

        assertTrue(state.scheduledAt(now, TZ));
        assertFalse(state.activeAt(now, TZ));
        assertEquals(now + 30 * 60_000L, state.nextChangeAfter(now, TZ));
        assertTrue(state.activeAt(now + 30 * 60_000L, TZ));
    }

    @Test
    public void dropsInvalidEntriesAndRoundTripsThePushedState() throws Exception {
        JSONObject policy = new JSONObject()
                .put("allowed_domains", new JSONArray()
                        .put("*.Example.com").put("example.com").put("localhost").put("bad_label.com").put("zhihu.com"))
                .put("active_windows", new JSONArray()
                        .put(new JSONObject().put("start", "22:00").put("end", "01:00"))
                        .put(new JSONObject().put("start", "8:00").put("end", "09:00"))
                        .put(new JSONObject().put("days", new JSONArray().put(6).put(9)).put("start", "19:00").put("end", "21:30")));
        LspWebAllowlistState state = LspWebAllowlistState.fromPolicy(policy, 1_234L);

        assertEquals(2, state.domains.size());
        assertEquals("example.com", state.domains.get(0));
        assertEquals(1, state.windows.size());
        JSONObject window = state.policyJson().getJSONArray("active_windows").getJSONObject(0);
        assertEquals("[6]", window.getJSONArray("days").toString());
        assertEquals("19:00", window.getString("start"));
        assertEquals("21:30", window.getString("end"));

        LspWebAllowlistState pushed = LspWebAllowlistState.fromStateJson(new JSONObject(state.stateJson().toString()));
        assertEquals(state.signature(), pushed.signature());
        assertEquals(1_234L, pushed.pausedUntilMs);
        assertFalse(LspWebAllowlistState.fromStateJson(new JSONObject().put("v", 99)).enabled());
    }

    @Test
    public void emptyDomainListDisablesFilteringEvenWithWindows() throws Exception {
        LspWebAllowlistState state = LspWebAllowlistState.fromPolicy(new JSONObject()
                .put("allowed_domains", new JSONArray())
                .put("active_windows", new JSONArray()), 0L);

        assertFalse(state.enabled());
        assertFalse(state.activeAt(at(2026, 10, 26, 9, 0), TZ));
        assertEquals(Long.MAX_VALUE, state.nextChangeAfter(at(2026, 10, 26, 9, 0), TZ));
    }

    private static JSONObject policy(JSONArray windows) throws Exception {
        return new JSONObject()
                .put("allowed_domains", new JSONArray().put("example.com").put("wikipedia.org"))
                .put("active_windows", windows);
    }

    private static long at(int year, int month, int day, int hour, int minute) {
        return ZonedDateTime.of(year, month, day, hour, minute, 0, 0, SHANGHAI).toInstant().toEpochMilli();
    }
}
