package com.monika.dashboard.data

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceTokenInputTest {
    @Test
    fun fullDeviceTokenRecordIsNormalizedToItsSecretBeforeSaving() {
        assertEquals(
            "b59bb798ca21d90340cc37bf61e5a1ae",
            SettingsStore.normalizeDeviceTokenInput(
                "  b59bb798ca21d90340cc37bf61e5a1ae:android-live:我的:手机:android  ",
            ),
        )
    }

    @Test
    fun ordinaryTokenContainingAColonIsNotMistakenForADeviceTokenRecord() {
        assertEquals(
            "custom:token",
            SettingsStore.normalizeDeviceTokenInput(" custom:token "),
        )
    }
}
