package com.monika.dashboard.coyote

class CoyoteSafetyPolicy(
    maxStrengthA: Int,
    maxStrengthB: Int,
) {
    val limitA: Int = maxStrengthA.coerceIn(0, MAX_STRENGTH)
    val limitB: Int = maxStrengthB.coerceIn(0, MAX_STRENGTH)

    fun coldStart(channel: CoyoteChannel, requestedStrength: Int): Int =
        requestedStrength.coerceIn(0, minOf(COLD_START_LIMIT, limit(channel)))

    fun adjustDelta(requestedDelta: Int): Int = requestedDelta.coerceIn(-ADJUST_STEP_LIMIT, ADJUST_STEP_LIMIT)

    fun targetStrength(channel: CoyoteChannel, current: Int, requestedDelta: Int): Int =
        (current + adjustDelta(requestedDelta)).coerceIn(0, limit(channel))

    fun absoluteStrength(channel: CoyoteChannel, requestedStrength: Int): Int =
        requestedStrength.coerceIn(0, limit(channel))

    fun limit(channel: CoyoteChannel): Int = if (channel == CoyoteChannel.A) limitA else limitB

    companion object {
        const val DEFAULT_USER_LIMIT = 50
        const val COLD_START_LIMIT = 10
        const val ADJUST_STEP_LIMIT = 10
        const val MAX_STRENGTH = 200
    }
}
