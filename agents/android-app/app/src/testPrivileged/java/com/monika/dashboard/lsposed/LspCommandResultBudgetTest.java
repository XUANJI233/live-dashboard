package com.monika.dashboard.lsposed;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.annotation.Config;

@RunWith(AndroidJUnit4.class)
@Config(sdk = 35)
public class LspCommandResultBudgetTest {
    private static final String LONG_REASON = repeat("今晚十点前不刷短视频", 50);

    @Test
    public void smallResultIsLeftAlone() throws Exception {
        JSONObject result = result(actions(3, LONG_REASON), state(3));
        String before = result.toString();

        assertSame(result, LspCommandResultBudget.fit(result, LONG_REASON));
        assertEquals(before, result.toString());
    }

    @Test
    public void largeUnfreezeKeepsEveryPackageActionAndDropsEchoedReasons() throws Exception {
        JSONObject result = result(actions(80, LONG_REASON), state(0));
        assertTrue(LspCommandResultBudget.bytes(result) > LspCommandResultBudget.MAX_RESULT_BYTES);

        LspCommandResultBudget.fit(result, LONG_REASON);

        JSONArray actions = result.getJSONArray("actions");
        assertEquals(80, actions.length());
        assertFalse(actions.getJSONObject(0).has("reason"));
        assertEquals("com.example.app001", actions.getJSONObject(0).getString("package_name"));
        assertFalse(result.has(LspCommandResultBudget.FIELD_ACTIONS_TRUNCATED));
        assertTrue(LspCommandResultBudget.bytes(result) <= LspCommandResultBudget.MAX_RESULT_BYTES);
    }

    @Test
    public void codesSurviveCompaction() throws Exception {
        JSONArray actions = actions(80, LONG_REASON);
        actions.getJSONObject(5).put("reason", "already_frozen");
        JSONObject result = result(actions, state(0));

        LspCommandResultBudget.fit(result, LONG_REASON);

        assertEquals("already_frozen", result.getJSONArray("actions").getJSONObject(5).getString("reason"));
    }

    @Test
    public void stateAfterShrinksBeforeActionsButKeepsItsTotal() throws Exception {
        JSONObject state = state(80);
        JSONArray apps = state.getJSONArray("frozen_apps");
        for (int i = 0; i < apps.length(); i++) apps.getJSONObject(i).put("reason", LONG_REASON);
        JSONObject result = result(actions(12, ""), state);

        LspCommandResultBudget.fit(result, "");

        JSONObject stateAfter = result.getJSONObject("state_after");
        assertTrue(stateAfter.getJSONArray("frozen_apps").length() < 80);
        assertEquals(80, stateAfter.getJSONArray("frozen_packages").length());
        assertEquals(80, stateAfter.getInt("frozen_packages_total"));
        assertEquals(12, result.getJSONArray("actions").length());
        assertTrue(LspCommandResultBudget.bytes(result) <= LspCommandResultBudget.MAX_RESULT_BYTES);
    }

    @Test
    public void actionsAreCutOnlyAsALastResortAndSaySo() throws Exception {
        JSONArray actions = actions(400, "");
        for (int i = 0; i < actions.length(); i++) actions.getJSONObject(i).put("app_name", repeat("应用", 20));
        JSONObject result = result(actions, state(0));

        LspCommandResultBudget.fit(result, "");

        assertTrue(result.getBoolean(LspCommandResultBudget.FIELD_ACTIONS_TRUNCATED));
        assertTrue(result.getJSONArray("actions").length() < 400);
        assertTrue(LspCommandResultBudget.bytes(result) <= LspCommandResultBudget.MAX_RESULT_BYTES);
    }

    private static JSONObject result(JSONArray actions, JSONObject state) throws Exception {
        return new JSONObject()
                .put("type", LspDeviceCommandProtocol.TYPE_RESULT)
                .put("v", 1)
                .put("command_id", "cmd_1")
                .put("result_id", "res_1")
                .put("status", "applied")
                .put("actions", actions)
                .put("state_after", state);
    }

    private static JSONArray actions(int count, String reason) throws Exception {
        JSONArray actions = new JSONArray();
        for (int i = 1; i <= count; i++) {
            JSONObject action = new JSONObject()
                    .put("action", "unfreeze")
                    .put("status", "applied")
                    .put("package_name", LspFrozenPackageStoreTest.pkg(i))
                    .put("app_name", "应用" + i)
                    .put("mode", "suspended");
            if (reason.length() > 0) action.put("reason", reason);
            actions.put(action);
        }
        return actions;
    }

    private static JSONObject state(int count) throws Exception {
        JSONArray apps = new JSONArray();
        JSONArray names = new JSONArray();
        for (int i = 1; i <= count; i++) {
            apps.put(new JSONObject()
                    .put("package_name", LspFrozenPackageStoreTest.pkg(i))
                    .put("app_name", "应用" + i)
                    .put("frozen_at", "2026-10-30T10:00:00.000Z")
                    .put("until", "2026-10-31T19:00:00.000Z")
                    .put("mode", "suspended")
                    .put("reason", "commitment"));
            names.put(LspFrozenPackageStoreTest.pkg(i));
        }
        return new JSONObject()
                .put("frozen_apps", apps)
                .put("frozen_packages", names)
                .put("frozen_packages_total", count);
    }

    private static String repeat(String text, int times) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < times; i++) out.append(text);
        return out.toString();
    }
}
