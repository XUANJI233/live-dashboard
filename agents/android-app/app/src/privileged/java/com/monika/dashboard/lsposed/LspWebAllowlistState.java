package com.monika.dashboard.lsposed;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.regex.Pattern;

/**
 * Controller-authored strict web allowlist for the system browser plus the user's
 * bounded manual pause. Pure value logic shared by system_server and the browser
 * process so both sides decide "active" and "allowed" identically; times are device-local.
 */
final class LspWebAllowlistState {
    static final int STATE_SCHEMA_VERSION = 1;
    static final long MAX_PAUSE_MS = 60L * 60_000L;

    private static final int MAX_DOMAINS = 64;
    private static final int MAX_WINDOWS = 14;
    private static final int LOOKAHEAD_DAYS = 8;
    private static final Pattern DOMAIN_LABEL = Pattern.compile("^(?!-)[a-z0-9-]{1,63}(?<!-)$");
    private static final Pattern CLOCK = Pattern.compile("^([01]\\d|2[0-3]):([0-5]\\d)$");

    static final class Window {
        /** Bit (ISO weekday - 1); zero means every day. */
        final int dayMask;
        final int startMinute;
        final int endMinute;

        Window(int dayMask, int startMinute, int endMinute) {
            this.dayMask = dayMask;
            this.startMinute = startMinute;
            this.endMinute = endMinute;
        }

        boolean appliesTo(int isoDay) {
            return dayMask == 0 || (dayMask & (1 << (isoDay - 1))) != 0;
        }

        boolean contains(int isoDay, int minuteOfDay) {
            return appliesTo(isoDay) && minuteOfDay >= startMinute && minuteOfDay < endMinute;
        }
    }

    final List<String> domains;
    final List<Window> windows;
    final long pausedUntilMs;

    private LspWebAllowlistState(List<String> domains, List<Window> windows, long pausedUntilMs) {
        this.domains = Collections.unmodifiableList(domains);
        this.windows = Collections.unmodifiableList(windows);
        this.pausedUntilMs = Math.max(0L, pausedUntilMs);
    }

    static LspWebAllowlistState empty() {
        return new LspWebAllowlistState(new ArrayList<>(), new ArrayList<>(), 0L);
    }

    /** Parse the server policy shape {allowed_domains, active_windows}; null means disabled. */
    static LspWebAllowlistState fromPolicy(JSONObject policy, long pausedUntilMs) {
        if (policy == null) return new LspWebAllowlistState(new ArrayList<>(), new ArrayList<>(), pausedUntilMs);
        return new LspWebAllowlistState(
                parseDomains(policy.optJSONArray("allowed_domains")),
                parseWindows(policy.optJSONArray("active_windows")),
                pausedUntilMs);
    }

    /** Parse the state system_server pushes to the browser process. */
    static LspWebAllowlistState fromStateJson(JSONObject state) {
        if (state == null || state.optInt("v", -1) != STATE_SCHEMA_VERSION) return empty();
        return fromPolicy(state, state.optLong("paused_until_ms", 0L));
    }

    LspWebAllowlistState withPausedUntil(long untilMs) {
        return new LspWebAllowlistState(new ArrayList<>(domains), new ArrayList<>(windows), untilMs);
    }

    JSONObject policyJson() {
        JSONObject json = new JSONObject();
        LspDeviceCommandProtocol.put(json, "allowed_domains", new JSONArray(domains));
        JSONArray windowArray = new JSONArray();
        for (Window window : windows) {
            JSONObject item = new JSONObject();
            JSONArray days = new JSONArray();
            for (int day = 1; day <= 7; day++) {
                if (window.dayMask != 0 && window.appliesTo(day)) days.put(day);
            }
            LspDeviceCommandProtocol.put(item, "days", days);
            LspDeviceCommandProtocol.put(item, "start", clock(window.startMinute));
            LspDeviceCommandProtocol.put(item, "end", clock(window.endMinute));
            windowArray.put(item);
        }
        LspDeviceCommandProtocol.put(json, "active_windows", windowArray);
        return json;
    }

    JSONObject stateJson() {
        JSONObject json = policyJson();
        LspDeviceCommandProtocol.put(json, "v", STATE_SCHEMA_VERSION);
        LspDeviceCommandProtocol.put(json, "paused_until_ms", pausedUntilMs);
        return json;
    }

    boolean enabled() {
        return !domains.isEmpty();
    }

    boolean pausedAt(long now) {
        return now < pausedUntilMs;
    }

    /** Whether the allowlist would apply now, ignoring a manual pause. */
    boolean scheduledAt(long now, TimeZone timeZone) {
        if (!enabled()) return false;
        if (windows.isEmpty()) return true;
        Calendar calendar = calendar(now, timeZone);
        int isoDay = isoDay(calendar);
        int minute = calendar.get(Calendar.HOUR_OF_DAY) * 60 + calendar.get(Calendar.MINUTE);
        for (Window window : windows) {
            if (window.contains(isoDay, minute)) return true;
        }
        return false;
    }

    boolean activeAt(long now, TimeZone timeZone) {
        return !pausedAt(now) && scheduledAt(now, timeZone);
    }

    /** Earliest time after now when activeAt can change, or Long.MAX_VALUE. */
    long nextChangeAfter(long now, TimeZone timeZone) {
        long next = pausedAt(now) ? pausedUntilMs : Long.MAX_VALUE;
        if (!enabled() || windows.isEmpty()) return next;
        Calendar day = calendar(now, timeZone);
        day.set(Calendar.HOUR_OF_DAY, 0);
        day.set(Calendar.MINUTE, 0);
        day.set(Calendar.SECOND, 0);
        day.set(Calendar.MILLISECOND, 0);
        for (int offset = 0; offset < LOOKAHEAD_DAYS; offset++) {
            int isoDay = isoDay(day);
            for (Window window : windows) {
                if (!window.appliesTo(isoDay)) continue;
                for (int minute : new int[] {window.startMinute, window.endMinute}) {
                    Calendar boundary = (Calendar) day.clone();
                    boundary.set(Calendar.HOUR_OF_DAY, minute / 60);
                    boundary.set(Calendar.MINUTE, minute % 60);
                    long at = boundary.getTimeInMillis();
                    if (at > now && at < next) next = at;
                }
            }
            day.add(Calendar.DAY_OF_YEAR, 1);
        }
        return next;
    }

    /** Only http(s) navigations are filtered; internal and data pages always pass. */
    boolean allowsUrl(String url) {
        String lower = url == null ? "" : url.trim().toLowerCase(Locale.US);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) return true;
        return allowsHost(hostOf(lower));
    }

    boolean allowsHost(String host) {
        String clean = normalizeDomain(host);
        if (clean.length() == 0) return false;
        for (String domain : domains) {
            if (clean.equals(domain) || clean.endsWith("." + domain)) return true;
        }
        return false;
    }

    String signature() {
        return stateJson().toString();
    }

    static String hostOf(String url) {
        String value = url == null ? "" : url.trim().toLowerCase(Locale.US);
        int scheme = value.indexOf("://");
        if (scheme < 0) return "";
        value = value.substring(scheme + 3);
        int end = value.length();
        for (char stop : new char[] {'/', '?', '#'}) {
            int index = value.indexOf(stop);
            if (index >= 0 && index < end) end = index;
        }
        value = value.substring(0, end);
        int at = value.lastIndexOf('@');
        if (at >= 0) value = value.substring(at + 1);
        int colon = value.lastIndexOf(':');
        if (colon >= 0 && value.indexOf(']') < colon) value = value.substring(0, colon);
        return value;
    }

    static String normalizeDomain(String value) {
        String host = value == null ? "" : value.trim().toLowerCase(Locale.US);
        if (host.startsWith("*.")) host = host.substring(2);
        while (host.startsWith(".")) host = host.substring(1);
        while (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.length() == 0 || host.length() > 253) return "";
        String[] labels = host.split("\\.", -1);
        if (labels.length < 2) return "";
        for (String label : labels) {
            if (!DOMAIN_LABEL.matcher(label).matches()) return "";
        }
        return host;
    }

    private static List<String> parseDomains(JSONArray array) {
        ArrayList<String> out = new ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length() && out.size() < MAX_DOMAINS; i++) {
            String domain = normalizeDomain(array.optString(i, ""));
            if (domain.length() > 0 && !out.contains(domain)) out.add(domain);
        }
        return out;
    }

    private static List<Window> parseWindows(JSONArray array) {
        ArrayList<Window> out = new ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length() && out.size() < MAX_WINDOWS; i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            int start = minuteOf(item.optString("start", ""));
            int end = minuteOf(item.optString("end", ""));
            if (start < 0 || end < 0 || start >= end) continue;
            int mask = 0;
            JSONArray days = item.optJSONArray("days");
            if (days != null) {
                for (int d = 0; d < days.length(); d++) {
                    int day = days.optInt(d, 0);
                    if (day >= 1 && day <= 7) mask |= 1 << (day - 1);
                }
            }
            out.add(new Window(mask, start, end));
        }
        return out;
    }

    private static int minuteOf(String value) {
        java.util.regex.Matcher matcher = CLOCK.matcher(value == null ? "" : value);
        if (!matcher.matches()) return -1;
        return Integer.parseInt(matcher.group(1)) * 60 + Integer.parseInt(matcher.group(2));
    }

    private static String clock(int minute) {
        return String.format(Locale.US, "%02d:%02d", minute / 60, minute % 60);
    }

    private static Calendar calendar(long now, TimeZone timeZone) {
        Calendar calendar = Calendar.getInstance(timeZone != null ? timeZone : TimeZone.getDefault(), Locale.US);
        calendar.setTimeInMillis(now);
        return calendar;
    }

    private static int isoDay(Calendar calendar) {
        int day = calendar.get(Calendar.DAY_OF_WEEK);
        return day == Calendar.SUNDAY ? 7 : day - 1;
    }
}
