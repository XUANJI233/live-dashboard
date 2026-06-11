package com.monika.dashboard.lsposed;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;

@RunWith(AndroidJUnit4.class)
public class LspSupervisionPolicyTest {
    private static final long NOW = 1_700_000_000_000L;

    @Test
    public void riskReviewWaitsForThresholdAndKeepsPendingUntilUploadSucceeds() throws Exception {
        LspSupervisionPolicy policy = new LspSupervisionPolicy();
        policy.applyPolicy(policyJson(
                new JSONArray().put("Video"),
                3,
                new JSONArray()));

        LspSupervisionPolicy.Decision first = policy.evaluate(
                "com.example.video",
                "Video",
                "Feed",
                NOW,
                false);
        assertEquals("", first.riskReviewPackage);
        assertFalse(policy.shouldRequestReviewForReport());

        LspSupervisionPolicy.Decision triggered = policy.evaluate(
                "com.example.video",
                "Video",
                "Feed",
                NOW + 3 * 60_000L + 1L,
                false);
        assertEquals("com.example.video", triggered.riskReviewPackage);
        assertEquals(LspSupervisionPolicy.PENDING_RISK_FREEZE_REASON, triggered.riskReviewReason);
        assertTrue(policy.shouldRequestReviewForReport());

        policy.markReviewRequestSent();
        assertFalse(policy.shouldRequestReviewForReport());

        LspSupervisionPolicy.Decision repeated = policy.evaluate(
                "com.example.video",
                "Video",
                "Feed",
                NOW + 4 * 60_000L,
                false);
        assertEquals("", repeated.riskReviewPackage);
    }

    @Test
    public void timeLimitFreezesWithoutRequestingRiskReview() throws Exception {
        LspSupervisionPolicy policy = new LspSupervisionPolicy();
        policy.applyPolicy(policyJson(
                new JSONArray().put("Video"),
                3,
                new JSONArray().put(limitJson("Game", 1, "limit reached"))));

        policy.evaluate("com.example.game", "Game", "Level", NOW, false);
        LspSupervisionPolicy.Decision decision = policy.evaluate(
                "com.example.game",
                "Game",
                "Level",
                NOW + 60_001L,
                false);

        assertEquals("com.example.game", decision.timeLimitFreezePackage);
        assertEquals("limit reached", decision.timeLimitReason);
        assertEquals("", decision.riskReviewPackage);
        assertFalse(policy.shouldRequestReviewForReport());
    }

    @Test
    public void changedPolicyUpdateClearsTimeLimitDeduplication() throws Exception {
        LspSupervisionPolicy policy = new LspSupervisionPolicy();
        JSONObject policyJson = policyJson(
                new JSONArray(),
                3,
                new JSONArray().put(limitJson("Game", 1, "limit reached")));
        JSONObject updatedPolicyJson = policyJson(
                new JSONArray(),
                3,
                new JSONArray().put(limitJson("Game", 1, "new limit")));

        policy.applyPolicy(policyJson);
        policy.evaluate("com.example.game", "Game", "Level", NOW, false);
        LspSupervisionPolicy.Decision first = policy.evaluate(
                "com.example.game",
                "Game",
                "Level",
                NOW + 60_001L,
                false);
        assertEquals("com.example.game", first.timeLimitFreezePackage);

        policy.applyPolicy(updatedPolicyJson);
        LspSupervisionPolicy.Decision afterUpdate = policy.evaluate(
                "com.example.game",
                "Game",
                "Level",
                NOW + 60_002L,
                false);
        assertEquals("com.example.game", afterUpdate.timeLimitFreezePackage);
        assertEquals("new limit", afterUpdate.timeLimitReason);
    }

    @Test
    public void samePolicyResendDoesNotResetPendingRiskOrTimeLimitDeduplication() throws Exception {
        LspSupervisionPolicy policy = new LspSupervisionPolicy();
        JSONObject policyJson = policyJson(
                new JSONArray().put("Video"),
                3,
                new JSONArray().put(limitJson("Game", 1, "limit reached")));

        policy.applyPolicy(policyJson);
        policy.evaluate("com.example.video", "Video", "Feed", NOW, false);
        LspSupervisionPolicy.Decision risk = policy.evaluate(
                "com.example.video",
                "Video",
                "Feed",
                NOW + 3 * 60_000L + 1L,
                false);
        assertEquals("com.example.video", risk.riskReviewPackage);
        assertTrue(policy.shouldRequestReviewForReport());

        policy.applyPolicy(policyJson);
        assertTrue(policy.shouldRequestReviewForReport());
        LspSupervisionPolicy.Decision repeatedRisk = policy.evaluate(
                "com.example.video",
                "Video",
                "Feed",
                NOW + 3 * 60_000L + 2L,
                false);
        assertEquals("", repeatedRisk.riskReviewPackage);

        policy.markReviewRequestSent();
        policy.evaluate("com.example.game", "Game", "Level", NOW + 4 * 60_000L, false);
        LspSupervisionPolicy.Decision firstLimit = policy.evaluate(
                "com.example.game",
                "Game",
                "Level",
                NOW + 5 * 60_000L + 1L,
                false);
        assertEquals("com.example.game", firstLimit.timeLimitFreezePackage);

        policy.applyPolicy(policyJson);
        LspSupervisionPolicy.Decision repeatedLimit = policy.evaluate(
                "com.example.game",
                "Game",
                "Level",
                NOW + 5 * 60_000L + 2L,
                false);
        assertEquals("", repeatedLimit.timeLimitFreezePackage);
    }

    @Test
    public void riskCooldownUsesDelayedNextCheckInsteadOfOneSecondLoop() throws Exception {
        LspSupervisionPolicy policy = new LspSupervisionPolicy();
        policy.applyPolicy(policyJson(
                new JSONArray().put("Video"),
                3,
                new JSONArray()));

        policy.evaluate("com.example.video", "Video", "Feed", NOW, false);
        LspSupervisionPolicy.Decision triggered = policy.evaluate(
                "com.example.video",
                "Video",
                "Feed",
                NOW + 3 * 60_000L + 1L,
                false);
        assertEquals("com.example.video", triggered.riskReviewPackage);

        policy.finishPendingReview();
        LspSupervisionPolicy.Decision duringCooldown = policy.evaluate(
                "com.example.video",
                "Video",
                "Feed",
                NOW + 4 * 60_000L,
                false);
        assertEquals("", duringCooldown.riskReviewPackage);
        assertEquals(5 * 60_000L, duringCooldown.nextCheckDelayMs);
    }

    @Test
    public void overlappingRiskAndTimeLimitReturnSeparateDecisions() throws Exception {
        LspSupervisionPolicy policy = new LspSupervisionPolicy();
        policy.applyPolicy(policyJson(
                new JSONArray().put("Video"),
                3,
                new JSONArray().put(limitJson("Video", 1, "daily limit"))));

        policy.evaluate("com.example.video", "Video", "Feed", NOW, false);
        LspSupervisionPolicy.Decision limitOnly = policy.evaluate(
                "com.example.video",
                "Video",
                "Feed",
                NOW + 60_001L,
                false);
        assertEquals("com.example.video", limitOnly.timeLimitFreezePackage);
        assertEquals("daily limit", limitOnly.timeLimitReason);
        assertEquals("", limitOnly.riskReviewPackage);

        LspSupervisionPolicy.Decision riskAfterThreshold = policy.evaluate(
                "com.example.video",
                "Video",
                "Feed",
                NOW + 3 * 60_000L + 1L,
                false);
        assertEquals("", riskAfterThreshold.timeLimitFreezePackage);
        assertEquals("com.example.video", riskAfterThreshold.riskReviewPackage);
        assertEquals(LspSupervisionPolicy.PENDING_RISK_FREEZE_REASON, riskAfterThreshold.riskReviewReason);
        assertTrue(policy.shouldRequestReviewForReport());
    }

    private static JSONObject policyJson(JSONArray riskRegex, int riskMinutes, JSONArray limits) throws Exception {
        return new JSONObject()
                .put("risk_app_regex", riskRegex)
                .put("risk_trigger_minutes", riskMinutes)
                .put("app_time_limits", limits);
    }

    private static JSONObject limitJson(String appRegex, int minutes, String reason) throws Exception {
        return new JSONObject()
                .put("app_regex", appRegex)
                .put("limit_minutes", minutes)
                .put("reason", reason);
    }
}
