package com.monika.dashboard.lsposed;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.content.ComponentName;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowPackageManager;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RunWith(AndroidJUnit4.class)
@Config(sdk = 35)
public class LspInstalledAppScannerTest {
    private static final int SYSTEM = ApplicationInfo.FLAG_SYSTEM;
    private static final int UPDATED_SYSTEM = ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP;
    private static final Signature PLATFORM_KEY = new Signature("0123456789abcdef");
    private static final Signature VENDOR_KEY = new Signature("fedcba9876543210");

    private PackageManager pm;
    private ShadowPackageManager shadowPm;
    private final List<String> logs = new ArrayList<>();
    private final LspInstalledAppScanner scanner = new LspInstalledAppScanner(logs::add);
    private final LspProtectedPackagePolicy policy =
            new LspProtectedPackagePolicy("com.monika.dashboard", null, "com.miui.home"::equals);

    @Before
    public void setUp() {
        pm = ApplicationProvider.getApplicationContext().getPackageManager();
        shadowPm = shadowOf(pm);
        install("android", "Android System", SYSTEM, 1000, PLATFORM_KEY, false, false);
    }

    @Test
    public void listsThirdPartyPreloadsWhileOemAndPlatformAppsStayProtected() {
        install("com.ss.android.ugc.aweme", "抖音", UPDATED_SYSTEM, 10_100, VENDOR_KEY, true, false);
        install("com.xingin.xhs", "小红书", 0, 10_101, VENDOR_KEY, true, false);
        install("com.miui.gallery", "相册", UPDATED_SYSTEM, 10_102, VENDOR_KEY, true, false);
        install("com.tencent.soter.soterserver", "SoterService", SYSTEM, 10_103, VENDOR_KEY, false, false);
        install("com.sohu.inputmethod.sogou.xiaomi", "搜狗输入法", SYSTEM, 10_104, VENDOR_KEY, true, true);
        install("com.example.userime", "User IME", 0, 10_105, VENDOR_KEY, true, true);
        install("com.vendor.console", "Console", SYSTEM, 10_106, PLATFORM_KEY, true, false);
        install("com.vendor.shareduid", "Shared", SYSTEM, 1000, VENDOR_KEY, true, false);
        install("com.miui.home", "桌面", SYSTEM, 10_107, VENDOR_KEY, true, false);

        Map<String, String> listed = scan();

        assertEquals("抖音", listed.get("com.ss.android.ugc.aweme"));
        assertEquals("小红书", listed.get("com.xingin.xhs"));
        for (String hidden : new String[]{
                "android",
                "com.miui.gallery",
                "com.tencent.soter.soterserver",
                "com.sohu.inputmethod.sogou.xiaomi",
                "com.example.userime",
                "com.vendor.console",
                "com.vendor.shareduid",
                "com.miui.home"}) {
            assertFalse(hidden, listed.containsKey(hidden));
        }
        assertEquals(1, logs.size());
        assertTrue(logs.get(0), logs.get(0).contains("third_party_preloads=1 [com.ss.android.ugc.aweme]"));
    }

    @Test
    public void summaryIsLoggedOnlyWhenTheOutcomeChanges() {
        install("com.xingin.xhs", "小红书", 0, 10_101, VENDOR_KEY, true, false);
        scan();
        scan();
        assertEquals(1, logs.size());

        install("com.ss.android.ugc.aweme", "抖音", UPDATED_SYSTEM, 10_100, VENDOR_KEY, true, false);
        scan();
        assertEquals(2, logs.size());
    }

    @Test
    public void singlePackageChecksMatchTheScan() {
        install("com.ss.android.ugc.aweme", "抖音", UPDATED_SYSTEM, 10_100, VENDOR_KEY, true, false);
        install("com.vendor.console", "Console", SYSTEM, 10_106, PLATFORM_KEY, true, false);
        install("com.example.userime", "User IME", 0, 10_105, VENDOR_KEY, true, true);

        assertTrue(LspInstalledAppScanner.providesInputMethod(pm, "com.example.userime"));
        assertFalse(LspInstalledAppScanner.providesInputMethod(pm, "com.ss.android.ugc.aweme"));
        assertTrue(LspPreloadedAppPolicy.hasLauncherEntry(pm, "com.ss.android.ugc.aweme"));
        assertFalse(LspPreloadedAppPolicy.hasLauncherEntry(pm, "android"));
        assertTrue(LspPreloadedAppPolicy.isThirdPartyPreload(pm, appInfo("com.ss.android.ugc.aweme"), true));
        assertFalse(LspPreloadedAppPolicy.isThirdPartyPreload(pm, appInfo("com.vendor.console"), true));
    }

    @Test
    public void preloadCandidatesExcludePlatformNamespacesSharedUidsAndUnlaunchableApps() {
        assertTrue(LspPreloadedAppPolicy.isPreloadCandidate("com.ss.android.ugc.aweme", 10_123, true));
        assertTrue(LspPreloadedAppPolicy.isPreloadCandidate("com.xingin.xhs", 1_010_123, true));
        assertFalse(LspPreloadedAppPolicy.isPreloadCandidate("com.ss.android.ugc.aweme", 10_123, false));
        assertFalse(LspPreloadedAppPolicy.isPreloadCandidate("com.example.phone", 1_001, true));
        assertFalse(LspPreloadedAppPolicy.isPreloadCandidate("com.example.phone", 1_001_001, true));
        assertFalse(LspPreloadedAppPolicy.isPreloadCandidate("android", 1_000, true));
        for (String oem : new String[]{
                "com.android.chrome",
                "com.google.android.youtube",
                "com.miui.video",
                "com.xiaomi.market",
                "com.mi.health",
                "com.huawei.appmarket",
                "com.qualcomm.qti.services"}) {
            assertFalse(oem, LspPreloadedAppPolicy.isPreloadCandidate(oem, 10_200, true));
        }
    }

    private Map<String, String> scan() {
        Map<String, String> out = new HashMap<>();
        for (LspInstalledApp app : scanner.scan(pm, policy)) out.put(app.packageName, app.label);
        return out;
    }

    private ApplicationInfo appInfo(String packageName) {
        try {
            return pm.getApplicationInfo(packageName, 0);
        } catch (PackageManager.NameNotFoundException e) {
            throw new AssertionError(e);
        }
    }

    private void install(
            String packageName,
            String label,
            int flags,
            int uid,
            Signature signature,
            boolean launcher,
            boolean inputMethod) {
        ApplicationInfo app = new ApplicationInfo();
        app.packageName = packageName;
        app.name = label;
        app.nonLocalizedLabel = label;
        app.flags = flags;
        app.uid = uid;
        PackageInfo info = new PackageInfo();
        info.packageName = packageName;
        info.applicationInfo = app;
        info.signatures = new Signature[]{signature};
        shadowPm.installPackage(info);
        if (launcher) {
            ComponentName activity = new ComponentName(packageName, packageName + ".Main");
            shadowPm.addActivityIfNotPresent(activity);
            IntentFilter filter = new IntentFilter(Intent.ACTION_MAIN);
            filter.addCategory(Intent.CATEGORY_LAUNCHER);
            shadowPm.addIntentFilterForActivity(activity, filter);
        }
        if (inputMethod) {
            ComponentName service = new ComponentName(packageName, packageName + ".Ime");
            shadowPm.addServiceIfNotPresent(service);
            shadowPm.addIntentFilterForService(service, new IntentFilter("android.view.InputMethod"));
        }
    }
}
