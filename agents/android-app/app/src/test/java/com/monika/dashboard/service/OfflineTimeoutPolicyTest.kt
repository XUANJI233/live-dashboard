package com.monika.dashboard.service

import org.junit.Assert.assertEquals
import org.junit.Test

class OfflineTimeoutPolicyTest {
    @Test
    fun sleepingWorkManagerCadenceIncludesGraceMinutes() {
        assertEquals(5, OfflineTimeoutPolicy.forCadenceSeconds(3 * 60))
    }

    @Test
    fun activeSubMinuteCadenceStillGetsAStableMinuteWindow() {
        assertEquals(3, OfflineTimeoutPolicy.forCadenceSeconds(30))
        assertEquals(3, OfflineTimeoutPolicy.forCadenceSeconds(50))
    }

    @Test
    fun reportedValueStaysWithinServerContract() {
        assertEquals(3, OfflineTimeoutPolicy.forCadenceSeconds(0))
        assertEquals(60, OfflineTimeoutPolicy.forCadenceSeconds(60 * 90))
    }
}
