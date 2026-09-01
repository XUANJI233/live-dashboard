package com.monika.dashboard.lsposed;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

final class LspSupervisionPolicy {
    static final String PENDING_RISK_FREEZE_REASON = "pending_supervision_review";

    private static final int DEFAULT_RISK_TRIGGER_MINUTES = 3;
    private static final long GLOBAL_RISK_COOLDOWN_MS = 60_000L;
    private static final long SAME_APP_RISK_COOLDOWN_MS = 10 * 60_000L;
    private static final long MIN_CHECK_DELAY_MS = 1000L;
    private static final long MAX_CHECK_DELAY_MS = 5 * 60_000L;

    private final Map<String, Long> usedMsByPackage = new HashMap<>();
    private final Map<String, Long> lastRiskRequestAtByPackage = new HashMap<>();
    private final Set<String> pendingRiskPackages = new HashSet<>();
    private final Set<String> limitFrozenPackages = new HashSet<>();

    private List<Pattern> riskPatterns = new ArrayList<>();
    private List<TimeLimitRule> timeLimitRules = new ArrayList<>();
    private int riskTriggerMinutes = DEFAULT_RISK_TRIGGER_MINUTES;
    private String policySignature = "";
    private String currentPackage = "";
    private String currentAppName = "";
    private String currentTitle = "";
    private long currentStartedAt = 0L;
    private long lastRiskRequestAt = 0L;
    private boolean reviewRequestPending = false;
    private String dayKey = "";

    synchronized boolean applyPolicy(JSONObject payload) {
        if (payload == null) return false;
        JSONArray riskArray = payload.optJSONArray("risk_app_regex");
        List<Pattern> nextRisk = LspDeviceCommandProtocol.compileSafePatterns(riskArray);
        ArrayList<TimeLimitRule> nextLimits = new ArrayList<>();
        JSONArray limits = payload.optJSONArray("app_time_limits");
        if (limits != null) {
            for (int i = 0; i < limits.length(); i++) {
                JSONObject item = limits.optJSONObject(i);
                if (item == null) continue;
                String pattern = LspDeviceCommandProtocol.safeString(item.optString("app_regex", ""));
                JSONArray single = new JSONArray();
                single.put(pattern);
                List<Pattern> compiled = LspDeviceCommandProtocol.compileSafePatterns(single);
                if (compiled.isEmpty()) continue;
                int minutes = clampMinutes(item.optInt("limit_minutes", DEFAULT_RISK_TRIGGER_MINUTES));
                String reason = LspDeviceCommandProtocol.safeString(item.optString("reason", ""));
                nextLimits.add(new TimeLimitRule(compiled.get(0), minutes, reason));
                if (nextLimits.size() >= 12) break;
            }
        }
        int nextRiskTriggerMinutes = clampMinutes(payload.optInt("risk_trigger_minutes", DEFAULT_RISK_TRIGGER_MINUTES));
        String nextSignature = policySignature(nextRisk, nextLimits, nextRiskTriggerMinutes);
        boolean changed = !nextSignature.equals(policySignature);
        riskPatterns = nextRisk;
        timeLimitRules = nextLimits;
        riskTriggerMinutes = nextRiskTriggerMinutes;
        policySignature = nextSignature;
        if (changed) {
            pendingRiskPackages.clear();
            limitFrozenPackages.clear();
            reviewRequestPending = false;
        }
        return true;
    }

    synchronized JSONObject persistentSnapshot() {
        JSONArray riskArray = new JSONArray();
        for (Pattern pattern : riskPatterns) {
            riskArray.put(pattern.pattern());
        }
        JSONArray limits = new JSONArray();
        for (TimeLimitRule rule : timeLimitRules) {
            JSONObject item = new JSONObject();
            LspDeviceCommandProtocol.put(item, "app_regex", rule.pattern.pattern());
            LspDeviceCommandProtocol.put(item, "limit_minutes", rule.limitMinutes);
            LspDeviceCommandProtocol.put(item, "reason", rule.reason);
            limits.put(item);
        }
        JSONObject snapshot = new JSONObject();
        LspDeviceCommandProtocol.put(snapshot, "risk_app_regex", riskArray);
        LspDeviceCommandProtocol.put(snapshot, "risk_trigger_minutes", riskTriggerMinutes);
        LspDeviceCommandProtocol.put(snapshot, "app_time_limits", limits);
        return snapshot;
    }

    synchronized Decision evaluate(
            String packageName,
            String appName,
            String title,
            long now,
            boolean protectedPackage) {
        resetDailyIfNeeded(now);
        String pkg = cleanPackage(packageName);
        String cleanAppName = LspDeviceCommandProtocol.safeString(appName);
        String cleanTitle = LspDeviceCommandProtocol.safeString(title);
        updateCurrentUsage(pkg, cleanAppName, cleanTitle, now);
        Decision decision = new Decision();
        if (protectedPackage || pkg.length() == 0 || "idle".equals(pkg) || "sleeping".equals(pkg)) {
            return decision;
        }

        long activeTotalMs = activeTotalMs(pkg, now);
        TimeLimitRule limitRule = matchingLimitRule(pkg, cleanAppName, cleanTitle);
        if (limitRule != null
                && activeTotalMs >= limitRule.limitMinutes * 60_000L
                && !limitFrozenPackages.contains(pkg)) {
            limitFrozenPackages.add(pkg);
            decision.timeLimitFreezePackage = pkg;
            decision.timeLimitReason = limitRule.reason.length() > 0
                    ? limitRule.reason
                    : "app_time_limit_exceeded";
        }

        boolean riskMatch = LspDeviceCommandProtocol.matchesAnyField(
                riskPatterns, pkg, cleanAppName, cleanTitle);
        if (riskMatch
                && activeTotalMs >= riskTriggerMinutes * 60_000L
                && !pendingRiskPackages.contains(pkg)
                && riskCooldownDue(pkg, now)) {
            pendingRiskPackages.add(pkg);
            lastRiskRequestAt = now;
            lastRiskRequestAtByPackage.put(pkg, now);
            reviewRequestPending = true;
            decision.riskReviewPackage = pkg;
            decision.riskReviewReason = PENDING_RISK_FREEZE_REASON;
        }
        decision.nextCheckDelayMs = nextCheckDelayMs(now);
        return decision;
    }

    synchronized boolean shouldRequestReviewForReport() {
        return reviewRequestPending;
    }

    synchronized void markReviewRequestSent() {
        reviewRequestPending = false;
    }

    synchronized void finishPendingReview() {
        pendingRiskPackages.clear();
        reviewRequestPending = false;
    }

    private void updateCurrentUsage(String pkg, String appName, String title, long now) {
        if (pkg.length() == 0 || "idle".equals(pkg) || "sleeping".equals(pkg)) {
            commitCurrent(now);
            currentPackage = "";
            currentAppName = "";
            currentTitle = "";
            currentStartedAt = 0L;
            return;
        }
        if (!pkg.equals(currentPackage)) {
            commitCurrent(now);
            currentPackage = pkg;
            currentAppName = appName;
            currentTitle = title;
            currentStartedAt = now;
        } else {
            currentAppName = appName;
            currentTitle = title;
            if (currentStartedAt <= 0L) currentStartedAt = now;
        }
    }

    private void commitCurrent(long now) {
        if (currentPackage.length() == 0 || currentStartedAt <= 0L || now <= currentStartedAt) return;
        long elapsed = Math.min(now - currentStartedAt, 60 * 60_000L);
        long total = usedMsByPackage.containsKey(currentPackage) ? usedMsByPackage.get(currentPackage) : 0L;
        usedMsByPackage.put(currentPackage, total + elapsed);
    }

    private long activeTotalMs(String pkg, long now) {
        long total = usedMsByPackage.containsKey(pkg) ? usedMsByPackage.get(pkg) : 0L;
        if (pkg.equals(currentPackage) && currentStartedAt > 0L && now > currentStartedAt) {
            total += now - currentStartedAt;
        }
        return Math.max(0L, total);
    }

    private long nextCheckDelayMs(long now) {
        if (currentPackage.length() == 0 || currentStartedAt <= 0L) return -1L;
        long total = activeTotalMs(currentPackage, now);
        long best = Long.MAX_VALUE;
        if (!pendingRiskPackages.contains(currentPackage)
                && LspDeviceCommandProtocol.matchesAnyField(
                        riskPatterns, currentPackage, currentAppName, currentTitle)) {
            long remainingToThreshold = riskTriggerMinutes * 60_000L - total;
            if (remainingToThreshold > 0L) {
                best = Math.min(best, remainingToThreshold);
            } else {
                long remainingCooldown = riskCooldownRemainingMs(currentPackage, now);
                best = Math.min(best, remainingCooldown > 0L ? remainingCooldown : MIN_CHECK_DELAY_MS);
            }
        }
        TimeLimitRule limitRule = matchingLimitRule(currentPackage, currentAppName, currentTitle);
        if (limitRule != null && !limitFrozenPackages.contains(currentPackage)) {
            best = Math.min(best, limitRule.limitMinutes * 60_000L - total);
        }
        if (best == Long.MAX_VALUE) return -1L;
        return Math.min(MAX_CHECK_DELAY_MS, Math.max(MIN_CHECK_DELAY_MS, best));
    }

    private boolean riskCooldownDue(String pkg, long now) {
        if (lastRiskRequestAt > 0L && now - lastRiskRequestAt >= 0L && now - lastRiskRequestAt < GLOBAL_RISK_COOLDOWN_MS) {
            return false;
        }
        Long lastForPackage = lastRiskRequestAtByPackage.get(pkg);
        return lastForPackage == null || now - lastForPackage < 0L || now - lastForPackage >= SAME_APP_RISK_COOLDOWN_MS;
    }

    private long riskCooldownRemainingMs(String pkg, long now) {
        long remaining = 0L;
        if (lastRiskRequestAt > 0L) {
            long age = now - lastRiskRequestAt;
            if (age >= 0L && age < GLOBAL_RISK_COOLDOWN_MS) {
                remaining = Math.max(remaining, GLOBAL_RISK_COOLDOWN_MS - age);
            }
        }
        Long lastForPackage = lastRiskRequestAtByPackage.get(pkg);
        if (lastForPackage != null) {
            long age = now - lastForPackage;
            if (age >= 0L && age < SAME_APP_RISK_COOLDOWN_MS) {
                remaining = Math.max(remaining, SAME_APP_RISK_COOLDOWN_MS - age);
            }
        }
        return remaining;
    }

    private TimeLimitRule matchingLimitRule(String packageName, String appName, String title) {
        for (TimeLimitRule rule : timeLimitRules) {
            try {
                if (LspDeviceCommandProtocol.matchesField(
                        rule.pattern, packageName, appName, title)) return rule;
            } catch (Throwable ignored) {}
        }
        return null;
    }

    private void resetDailyIfNeeded(long now) {
        String today = dayKey(now);
        if (today.equals(dayKey)) return;
        dayKey = today;
        usedMsByPackage.clear();
        pendingRiskPackages.clear();
        limitFrozenPackages.clear();
        lastRiskRequestAtByPackage.clear();
        reviewRequestPending = false;
        currentPackage = "";
        currentAppName = "";
        currentTitle = "";
        currentStartedAt = 0L;
    }

    private String dayKey(long now) {
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(now);
        return String.format(Locale.US, "%04d-%02d-%02d",
                calendar.get(Calendar.YEAR),
                calendar.get(Calendar.MONTH) + 1,
                calendar.get(Calendar.DAY_OF_MONTH));
    }

    private int clampMinutes(int value) {
        return Math.max(1, Math.min(55, value));
    }

    private String cleanPackage(String value) {
        String clean = LspDeviceCommandProtocol.safeString(value);
        return clean.length() > 160 ? clean.substring(0, 160) : clean;
    }

    private String policySignature(List<Pattern> risk, List<TimeLimitRule> limits, int riskMinutes) {
        StringBuilder out = new StringBuilder();
        out.append("riskMinutes=").append(riskMinutes).append(';');
        out.append("risk=");
        for (Pattern pattern : risk) {
            appendToken(out, pattern.pattern());
        }
        out.append(";limits=");
        for (TimeLimitRule rule : limits) {
            appendToken(out, rule.pattern.pattern());
            out.append(rule.limitMinutes).append(':');
            appendToken(out, rule.reason);
        }
        return out.toString();
    }

    private void appendToken(StringBuilder out, String value) {
        String clean = LspDeviceCommandProtocol.safeString(value);
        out.append(clean.length()).append(':').append(clean).append('|');
    }

    static final class Decision {
        String riskReviewPackage = "";
        String riskReviewReason = "";
        String timeLimitFreezePackage = "";
        String timeLimitReason = "";
        long nextCheckDelayMs = -1L;

        boolean hasAction() {
            return riskReviewPackage.length() > 0 || timeLimitFreezePackage.length() > 0;
        }
    }

    private static final class TimeLimitRule {
        final Pattern pattern;
        final int limitMinutes;
        final String reason;

        TimeLimitRule(Pattern pattern, int limitMinutes, String reason) {
            this.pattern = pattern;
            this.limitMinutes = limitMinutes;
            this.reason = reason;
        }
    }
}
