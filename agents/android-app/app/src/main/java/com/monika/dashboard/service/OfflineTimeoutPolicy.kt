package com.monika.dashboard.service

internal const val OFFLINE_TIMEOUT_FIELD = "offline_timeout_minutes"

internal object OfflineTimeoutPolicy {
    private const val MIN_REPORTED_TIMEOUT_MINUTES = 1
    private const val MAX_REPORTED_TIMEOUT_MINUTES = 60
    private const val REPORTING_GRACE_MINUTES = 2

    fun forCadenceSeconds(intervalSeconds: Int): Int {
        val cadenceMinutes = ceilMinutes(intervalSeconds)
        return (cadenceMinutes + REPORTING_GRACE_MINUTES)
            .coerceIn(MIN_REPORTED_TIMEOUT_MINUTES, MAX_REPORTED_TIMEOUT_MINUTES)
    }

    private fun ceilMinutes(seconds: Int): Int {
        val safeSeconds = seconds.coerceAtLeast(1)
        return (safeSeconds + 59) / 60
    }
}
