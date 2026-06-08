package com.monika.dashboard.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.monika.dashboard.system.AudioOutputInfo
import com.monika.dashboard.system.DeviceEnvironment
import com.monika.dashboard.system.ForegroundInfo
import com.monika.dashboard.system.SystemSnapshot
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ReportCadenceStoreTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        ReportCadenceStore.clearForTest(context)
    }

    @After
    fun tearDown() {
        ReportCadenceStore.clearForTest(context)
    }

    @Test
    fun unchangedStateBecomesHeartbeatOnlyAfterSuccessfulFullReport() {
        val signature = ReportCadenceStore.signature(
            appId = "com.android.browser",
            windowTitle = "Docs",
            snapshot = SystemSnapshot(
                foreground = ForegroundInfo(packageName = "com.android.browser", title = "Docs"),
            ),
            environment = DeviceEnvironment(audioOutput = AudioOutputInfo(true, "bluetooth_headset")),
        )

        assertFalse(ReportCadenceStore.shouldSendHeartbeatOnly(context, signature, now = 1_000L))
        ReportCadenceStore.markSent(context, signature, heartbeatOnly = false, now = 1_000L)
        assertTrue(ReportCadenceStore.shouldSendHeartbeatOnly(context, signature, now = 2_000L))
    }

    @Test
    fun changedMediaTitleRequiresFullReport() {
        val first = ReportCadenceStore.signature(
            appId = "music",
            windowTitle = "Song A",
            snapshot = null,
            environment = null,
        )
        val second = ReportCadenceStore.signature(
            appId = "music",
            windowTitle = "Song B",
            snapshot = null,
            environment = null,
        )

        ReportCadenceStore.markSent(context, first, heartbeatOnly = false, now = 1_000L)

        assertNotEquals(first, second)
        assertFalse(ReportCadenceStore.shouldSendHeartbeatOnly(context, second, now = 2_000L))
    }
}
