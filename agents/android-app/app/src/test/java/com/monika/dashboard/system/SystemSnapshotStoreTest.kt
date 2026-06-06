package com.monika.dashboard.system

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test

class SystemSnapshotStoreTest {

    @Before
    fun setUp() {
        SystemSnapshotStore.clearForTest()
    }

    @After
    fun tearDown() {
        SystemSnapshotStore.clearForTest()
    }

    @Test
    fun explicitBlankTitleClearsPreviousBrowserTitle() {
        val foreground = ForegroundInfo(
            packageName = "com.android.browser",
            appName = "Browser",
            activity = "com.android.browser.BrowserActivity",
            title = "旧页面",
            source = "lsposed",
            confidence = 0.95,
        )
        SystemSnapshotStore.updateFromLsposed(
            SystemSnapshot(capabilityMode = "lsposed", foreground = foreground),
        )

        SystemSnapshotStore.updateFromLsposed(
            SystemSnapshot(
                capabilityMode = "lsposed",
                foreground = foreground.copy(title = ""),
            ),
        )

        val latest = SystemSnapshotStore.latestLsposedFresh()
        assertNotNull(latest)
        assertEquals("", latest?.foreground?.title)
    }
}
