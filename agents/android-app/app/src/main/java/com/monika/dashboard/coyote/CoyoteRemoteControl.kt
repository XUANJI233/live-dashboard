package com.monika.dashboard.coyote

import org.json.JSONObject

object CoyoteRemoteControl {
    suspend fun execute(command: JSONObject): JSONObject {
        val action = command.optString("action")
        val isStop = action == "stop" || action == "emergency_stop"
        if (!isStop && !CoyoteBleController.state.value.remoteControlEnabled) {
            return result(false, "remote_control_not_enabled")
        }
        val channel = if (command.optString("channel") == "B") CoyoteChannel.B else CoyoteChannel.A
        val outcome = when (action) {
            "start" -> CoyoteBleController.start(
                channel,
                command.optInt("strength", 0).coerceIn(0, CoyoteSafetyPolicy.COLD_START_LIMIT),
                command.optString("waveform", "pulse_mid"),
                command.strictBoolean("loop", true),
            )
            "adjust" -> CoyoteBleController.adjust(
                channel,
                command.optInt("delta", 0)
                    .coerceIn(-CoyoteSafetyPolicy.ADJUST_STEP_LIMIT, CoyoteSafetyPolicy.ADJUST_STEP_LIMIT),
            )
            "change_wave" -> CoyoteBleController.changeWave(
                channel,
                command.optString("waveform", "pulse_mid"),
                command.strictBoolean("loop", true),
            )
            "stop" -> CoyoteBleController.stop(if (command.has("channel")) channel else null)
            "emergency_stop" -> CoyoteBleController.emergencyStop()
            else -> CoyoteCommandOutcome(false, "unsupported_coyote_action")
        }
        val confirmed = CoyoteBleController.awaitPhysicalCommit(outcome)
        return result(confirmed.ok, confirmed.reason)
    }

    private fun result(ok: Boolean, reason: String): JSONObject = JSONObject().apply {
        put("ok", ok)
        put("status", if (ok) "applied" else "failed")
        put("reason", reason)
        put("coyote", CoyoteBleController.state.value.toJson())
    }

    private fun JSONObject.strictBoolean(key: String, fallback: Boolean): Boolean =
        if (!has(key) || isNull(key)) fallback else opt(key) as? Boolean ?: false
}
