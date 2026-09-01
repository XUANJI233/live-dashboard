package com.monika.dashboard.lsposed;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class LspDirectOfflineTimeoutPolicyTest {
    @Test
    public void activeThirtySecondCadenceReportsThreeMinuteOfflineTimeout() {
        assertEquals(3, LspDirectOfflineTimeoutPolicy.forReport(
                false,
                5 * 60_000L,
                5_000L,
                30_000L));
    }

    @Test
    public void sleepingReportKeepsLongerFallbackCadenceGrace() {
        assertEquals(7, LspDirectOfflineTimeoutPolicy.forReport(
                true,
                5 * 60_000L,
                5_000L,
                30_000L));
    }
}
