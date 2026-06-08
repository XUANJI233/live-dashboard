package com.monika.dashboard.system

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

data class AudioOutputInfo(
    val connected: Boolean,
    val type: String,
    val name: String = "",
    val source: String = "audio_manager",
)

data class DeviceEnvironment(
    val audioOutput: AudioOutputInfo? = null,
    val ambientLux: Float? = null,
    val sampledAt: Long = System.currentTimeMillis(),
)

object DeviceEnvironmentCollector {
    private const val LIGHT_CACHE_MS = 60_000L
    private const val LIGHT_TIMEOUT_MS = 350L

    @Volatile
    private var cachedLight: Pair<Long, Float>? = null

    suspend fun collect(context: Context): DeviceEnvironment {
        val appContext = context.applicationContext
        return DeviceEnvironment(
            audioOutput = collectAudioOutput(appContext),
            ambientLux = collectAmbientLux(appContext),
            sampledAt = System.currentTimeMillis(),
        )
    }

    fun collectAudioOutput(context: Context): AudioOutputInfo? {
        return try {
            val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return null
            val external = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                .mapNotNull { device -> audioCandidate(device) }
                .maxByOrNull { it.priority }
            if (external != null) {
                AudioOutputInfo(
                    connected = true,
                    type = external.type,
                    name = external.name,
                )
            } else {
                AudioOutputInfo(connected = false, type = "speaker")
            }
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun collectAmbientLux(context: Context): Float? {
        val now = System.currentTimeMillis()
        cachedLight?.let { (at, lux) ->
            if (now - at <= LIGHT_CACHE_MS) return lux
        }
        val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return null
        val sensor = manager.getDefaultSensor(Sensor.TYPE_LIGHT) ?: return null
        val lux = withTimeoutOrNull(LIGHT_TIMEOUT_MS) {
            suspendCancellableCoroutine<Float?> { cont ->
                val listener = object : SensorEventListener {
                    override fun onSensorChanged(event: SensorEvent?) {
                        val value = event?.values?.firstOrNull() ?: return
                        manager.unregisterListener(this)
                        if (cont.isActive) cont.resume(value.coerceIn(0f, 200_000f))
                    }

                    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
                }
                if (!manager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL, Handler(Looper.getMainLooper()))) {
                    cont.resume(null)
                    return@suspendCancellableCoroutine
                }
                cont.invokeOnCancellation { manager.unregisterListener(listener) }
            }
        }
        if (lux != null) cachedLight = System.currentTimeMillis() to lux
        return lux
    }

    private data class AudioCandidate(
        val type: String,
        val name: String,
        val priority: Int,
    )

    private fun audioCandidate(device: AudioDeviceInfo): AudioCandidate? {
        val label = when (device.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> AudioCandidate("bluetooth_headset", device.productNameText(), 90)
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> AudioCandidate("wired_headset", device.productNameText(), 80)
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_USB_DEVICE -> AudioCandidate("usb_audio", device.productNameText(), 70)
            AudioDeviceInfo.TYPE_HEARING_AID -> AudioCandidate("hearing_aid", device.productNameText(), 65)
            AudioDeviceInfo.TYPE_HDMI,
            AudioDeviceInfo.TYPE_HDMI_ARC,
            AudioDeviceInfo.TYPE_HDMI_EARC -> AudioCandidate("hdmi_audio", device.productNameText(), 50)
            else -> bluetoothLeCandidate(device)
        }
        return label
    }

    private fun bluetoothLeCandidate(device: AudioDeviceInfo): AudioCandidate? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        return when (device.type) {
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_BLE_SPEAKER,
            AudioDeviceInfo.TYPE_BLE_BROADCAST -> AudioCandidate("bluetooth_headset", device.productNameText(), 85)
            else -> null
        }
    }

    private fun AudioDeviceInfo.productNameText(): String =
        productName?.toString()?.take(64).orEmpty()
}
