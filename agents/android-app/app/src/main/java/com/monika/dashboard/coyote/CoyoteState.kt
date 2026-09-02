package com.monika.dashboard.coyote

import org.json.JSONObject

data class ScannedCoyote(
    val address: String,
    val name: String,
    val rssi: Int,
    val generation: CoyoteGeneration,
)

data class CoyoteDeviceState(
    val available: Boolean = false,
    val scanning: Boolean = false,
    val connecting: Boolean = false,
    val connected: Boolean = false,
    val deviceName: String = "",
    val address: String = "",
    val generation: CoyoteGeneration = CoyoteGeneration.UNKNOWN,
    val batteryPercent: Int? = null,
    val strengthA: Int = 0,
    val strengthB: Int = 0,
    val limitA: Int = CoyoteSafetyPolicy.DEFAULT_USER_LIMIT,
    val limitB: Int = CoyoteSafetyPolicy.DEFAULT_USER_LIMIT,
    val waveActiveA: Boolean = false,
    val waveActiveB: Boolean = false,
    val waveformA: String = "",
    val waveformB: String = "",
    val remoteControlEnabled: Boolean = false,
    val discoveredDevices: List<ScannedCoyote> = emptyList(),
    val error: String = "",
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("available", available)
        put("connected", connected)
        put("device_name", deviceName)
        put("generation", generation.name.lowercase())
        if (batteryPercent == null) put("battery_percent", JSONObject.NULL) else put("battery_percent", batteryPercent)
        put("strength_a", strengthA)
        put("strength_b", strengthB)
        put("limit_a", limitA)
        put("limit_b", limitB)
        put("wave_active_a", waveActiveA)
        put("wave_active_b", waveActiveB)
        put("waveform_a", waveformA)
        put("waveform_b", waveformB)
        put("remote_control_enabled", remoteControlEnabled)
    }
}

data class CoyoteCommandOutcome(
    val ok: Boolean,
    val reason: String,
    val commitAfterSerial: Long? = null,
)
