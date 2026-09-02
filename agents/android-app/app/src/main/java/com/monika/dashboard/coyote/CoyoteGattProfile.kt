package com.monika.dashboard.coyote

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.util.UUID

object CoyoteGattProfile {
    const val V3_NAME_PREFIX = "47L121"
    const val V2_NAME_PREFIX = "D-LAB ESTIM"
    const val TRANSPORT_LE: Int = android.bluetooth.BluetoothDevice.TRANSPORT_LE

    val CLIENT_CONFIG_DESCRIPTOR: UUID = uuid("00002902-0000-1000-8000-00805f9b34fb")
    val BATTERY_SERVICE: UUID = uuid("0000180f-0000-1000-8000-00805f9b34fb")
    val BATTERY_CHAR: UUID = uuid("00002a19-0000-1000-8000-00805f9b34fb")
    val V3_PRIMARY_SERVICE: UUID = uuid("0000180c-0000-1000-8000-00805f9b34fb")
    val V3_WRITE_CHAR: UUID = uuid("0000150a-0000-1000-8000-00805f9b34fb")
    val V3_NOTIFY_CHAR: UUID = uuid("0000150b-0000-1000-8000-00805f9b34fb")
    val V3_LEGACY_SERVICE: UUID = uuid("0000ff0a-0000-1000-8000-00805f9b34fb")
    val V3_LEGACY_NOTIFY: UUID = uuid("0000ff00-0000-1000-8000-00805f9b34fb")
    val V3_OTA_SERVICE: UUID = uuid("f000ffc0-0451-4000-b000-000000000000")
    val V3_OTA_NOTIFY: UUID = uuid("f000ffc2-0451-4000-b000-000000000000")
    val V2_PRIMARY_SERVICE: UUID = v2Uuid("180b")
    val V2_STRENGTH_CHAR: UUID = v2Uuid("1504")
    val V2_WAVE_A_CHAR: UUID = v2Uuid("1505")
    val V2_WAVE_B_CHAR: UUID = v2Uuid("1506")
    val V2_BATTERY_SERVICE: UUID = v2Uuid("180a")
    val V2_BATTERY_CHAR: UUID = v2Uuid("1500")

    fun detectGeneration(name: String): CoyoteGeneration = when {
        name.startsWith(V3_NAME_PREFIX) -> CoyoteGeneration.V3
        name.startsWith(V2_NAME_PREFIX) -> CoyoteGeneration.V2
        else -> CoyoteGeneration.UNKNOWN
    }

    fun hasScanPermission(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
        } else {
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        }

    fun hasConnectPermission(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    private fun uuid(value: String): UUID = UUID.fromString(value)
    private fun v2Uuid(short: String): UUID = uuid("955a${short}-0fe2-f5aa-a094-84b8d4f3e8ad")
}
