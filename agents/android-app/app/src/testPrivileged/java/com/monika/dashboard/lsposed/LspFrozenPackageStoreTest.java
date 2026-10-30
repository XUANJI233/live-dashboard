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

import java.util.ArrayList;
import java.util.List;

@RunWith(AndroidJUnit4.class)
@Config(sdk = 35)
public class LspFrozenPackageStoreTest {
    private static final long NOW = 1_000_000L;
    private static final long UNTIL = NOW + 60 * 60_000L;

    @Test
    public void reportListsEveryFrozenPackageOldestFirstWithTotal() throws Exception {
        LspFrozenPackageStore store = new LspFrozenPackageStore();
        for (int i = 20; i >= 1; i--) {
            store.put(pkg(i), "App " + i, NOW - 1_000L * (21 - i), UNTIL, "commitment", "suspended");
        }

        JSONObject device = new JSONObject();
        store.putReport(device, NOW, LspFrozenPackageStoreTest::iso, null);

        JSONArray frozen = device.getJSONArray("frozen_packages");
        assertEquals(20, frozen.length());
        assertEquals(20, device.getInt("frozen_packages_total"));
        assertEquals(pkg(1), frozen.getJSONObject(0).getString("package_name"));
        assertEquals(pkg(20), frozen.getJSONObject(19).getString("package_name"));
        JSONObject first = frozen.getJSONObject(0);
        assertEquals("App 1", first.getString("app_name"));
        assertEquals(iso(UNTIL), first.getString("until"));
        assertEquals("commitment", first.getString("reason"));
        assertEquals("suspended", first.getString("mode"));
    }

    @Test
    public void reportStopsAtServerItemLimitButCountsEveryFreeze() throws Exception {
        LspFrozenPackageStore store = storeWith(100, "");

        JSONObject device = new JSONObject();
        store.putReport(device, NOW, LspFrozenPackageStoreTest::iso, null);

        assertEquals(LspFrozenPackageReport.MAX_ITEMS, device.getJSONArray("frozen_packages").length());
        assertEquals(100, device.getInt("frozen_packages_total"));
    }

    @Test
    public void longReasonsAreCutAndTheListStaysWithinItsByteBudget() throws Exception {
        LspFrozenPackageStore store = storeWith(80, repeat("专注学习", 125));

        JSONObject device = new JSONObject();
        store.putReport(device, NOW, LspFrozenPackageStoreTest::iso, null);

        JSONArray frozen = device.getJSONArray("frozen_packages");
        assertEquals(LspFrozenPackageReport.MAX_REASON_CHARS,
                frozen.getJSONObject(0).getString("reason").length());
        assertTrue(LspFrozenPackageReport.utf8Bytes(frozen.toString()) <= LspFrozenPackageReport.MAX_REPORT_BYTES);
        assertTrue(frozen.length() < 80);
        assertEquals(80, device.getInt("frozen_packages_total"));
    }

    @Test
    public void unfreezeSnapshotCoversEveryRecordNotOnlyTheFirstSixteen() {
        LspFrozenPackageStore store = storeWith(40, "commitment");

        List<LspFrozenPackage> snapshot = store.frozenPackages(NOW, null);

        assertEquals(40, snapshot.size());
        assertEquals(pkg(40), snapshot.get(39).packageName);
    }

    @Test
    public void stateAfterCarriesNamesAndTotalAndDropsExpiredRecords() throws Exception {
        LspFrozenPackageStore store = storeWith(12, "commitment");
        store.put("com.example.expired", "Expired", NOW - 5_000L, NOW - 1L, "old", "suspended");
        List<String> released = new ArrayList<>();

        JSONObject state = store.frozenState(NOW, LspFrozenPackageStoreTest::iso, record -> released.add(record.packageName));

        assertEquals(12, state.getJSONArray("frozen_apps").length());
        assertEquals(12, state.getJSONArray("frozen_packages").length());
        assertEquals(pkg(1), state.getJSONArray("frozen_packages").getString(0));
        assertEquals(12, state.getInt("frozen_packages_total"));
        assertEquals(1, released.size());
        assertFalse(state.toString().contains("com.example.expired"));
    }

    private static LspFrozenPackageStore storeWith(int count, String reason) {
        LspFrozenPackageStore store = new LspFrozenPackageStore();
        for (int i = 1; i <= count; i++) {
            store.put(pkg(i), "应用" + i, NOW - 1_000L * (count + 1 - i), UNTIL, reason, "suspended");
        }
        return store;
    }

    static String pkg(int index) {
        return String.format(java.util.Locale.ROOT, "com.example.app%03d", index);
    }

    private static String iso(long millis) {
        return "t" + millis;
    }

    private static String repeat(String text, int times) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < times; i++) out.append(text);
        return out.toString();
    }
}
