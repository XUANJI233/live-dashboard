package com.monika.dashboard.coyote

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.integration.AndroidIntegrationPreferences
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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

object CoyoteBleController {
    private const val SCAN_DURATION_MS = 10_000L
    private const val TICK_MS = 100L
    private const val V3_NAME_PREFIX = "47L121"
    private const val V2_NAME_PREFIX = "D-LAB ESTIM"

    private val mainHandler = Handler(Looper.getMainLooper())
    private val tickExecutor = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "coyote-protocol").apply { isDaemon = true }
    }
    private val lock = Any()
    private val mutableState = MutableStateFlow(CoyoteDeviceState())
    val state: StateFlow<CoyoteDeviceState> = mutableState.asStateFlow()

    private var appContext: Context? = null
    private var preferences: AndroidIntegrationPreferences? = null
    private var adapter: BluetoothAdapter? = null
    private var gatt: BluetoothGatt? = null
    private var generation = CoyoteGeneration.UNKNOWN
    private var ready = false
    private var setupStarted = false
    private var tickFuture: ScheduledFuture<*>? = null

    private var writeCharacteristic: BluetoothGattCharacteristic? = null
    private var notifyCharacteristic: BluetoothGattCharacteristic? = null
    private var batteryCharacteristic: BluetoothGattCharacteristic? = null
    private var v2StrengthCharacteristic: BluetoothGattCharacteristic? = null
    private var v2WaveACharacteristic: BluetoothGattCharacteristic? = null
    private var v2WaveBCharacteristic: BluetoothGattCharacteristic? = null

    private val writeQueue = ArrayDeque<PendingWrite>()
    private var currentWrite: PendingWrite? = null
    private val notificationQueue = ArrayDeque<NotificationTarget>()
    private var currentNotification: NotificationTarget? = null

    private var strengthA = 0
    private var strengthB = 0
    private var sequence = 0
    private var pendingMode = 0
    private var awaitingAck = false
    private var suppressStaleStopNotifications = false
    private val waves = mutableMapOf(
        CoyoteChannel.A to WavePlayback(),
        CoyoteChannel.B to WavePlayback(),
    )
    private val scanResults = linkedMapOf<String, ScannedCoyote>()
    private val scanTimeout = Runnable { stopScan() }

    fun initialize(context: Context) {
        synchronized(lock) {
            if (appContext != null) return
            appContext = context.applicationContext
            preferences = AndroidIntegrationPreferences(context)
            adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
            emitStateLocked()
        }
    }

    @SuppressLint("MissingPermission")
    fun startScan(): Boolean = synchronized(lock) {
        val context = appContext ?: return false
        val bluetoothAdapter = adapter ?: return failLocked("此设备没有蓝牙适配器")
        if (!hasScanPermission(context)) return failLocked("请先授予附近设备/蓝牙扫描权限")
        if (!bluetoothAdapter.isEnabled) return failLocked("请先打开蓝牙")
        stopScanLocked()
        scanResults.clear()
        mutableState.value = mutableState.value.copy(scanning = true, discoveredDevices = emptyList(), error = "")
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        return runCatching {
            bluetoothAdapter.bluetoothLeScanner.startScan(null, settings, scanCallback)
            mainHandler.postDelayed(scanTimeout, SCAN_DURATION_MS)
            true
        }.getOrElse { error -> failLocked("蓝牙扫描启动失败: ${error.message.orEmpty()}") }
    }

    @SuppressLint("MissingPermission")
    fun stopScan() {
        synchronized(lock) { stopScanLocked() }
    }

    @SuppressLint("MissingPermission")
    fun connect(address: String): Boolean = synchronized(lock) {
        val context = appContext ?: return false
        val bluetoothAdapter = adapter ?: return failLocked("此设备没有蓝牙适配器")
        if (!hasConnectPermission(context)) return failLocked("请先授予附近设备/蓝牙连接权限")
        stopScanLocked()
        closeGattLocked(sendEmergencyStop = true)
        val device = runCatching { bluetoothAdapter.getRemoteDevice(address) }.getOrNull()
            ?: return failLocked("无效的蓝牙设备地址")
        val name = scanResults[address]?.name
            ?: runCatching { device.name.orEmpty() }.getOrDefault("")
        generation = detectGeneration(name)
        if (generation == CoyoteGeneration.UNKNOWN) return failLocked("所选设备不是受支持的郊狼 V2/V3")
        mutableState.value = mutableState.value.copy(
            connecting = true,
            connected = false,
            deviceName = name,
            address = address,
            generation = generation,
            error = "",
        )
        return runCatching {
            val createdGatt = device.connectGatt(context, false, gattCallback, BluetoothDeviceTransport)
            gatt = createdGatt
            if (createdGatt == null) failLocked("连接郊狼失败: 系统未创建 GATT") else true
        }.getOrElse { error -> failLocked("连接郊狼失败: ${error.message.orEmpty()}") }
    }

    fun disconnect() {
        synchronized(lock) { closeGattLocked(sendEmergencyStop = true) }
    }

    fun setRemoteControlEnabled(enabled: Boolean) {
        synchronized(lock) {
            preferences?.coyoteRemoteControlEnabled = enabled
            emitStateLocked()
        }
    }

    fun updateLimits(limitA: Int, limitB: Int) {
        synchronized(lock) {
            val prefs = preferences ?: return
            prefs.coyoteLimitA = limitA
            prefs.coyoteLimitB = limitB
            val policy = policyLocked()
            strengthA = strengthA.coerceAtMost(policy.limitA)
            strengthB = strengthB.coerceAtMost(policy.limitB)
            if (ready && generation == CoyoteGeneration.V3) {
                enqueueWriteLocked(writeCharacteristic, CoyoteProtocolCodec.encodeV3Limits(policy.limitA, policy.limitB))
            }
            emitStateLocked()
        }
    }

    fun start(channel: CoyoteChannel, requestedStrength: Int, waveformId: String, loop: Boolean = true): CommandOutcome =
        synchronized(lock) {
            if (!ready) return CommandOutcome(false, "coyote_not_connected")
            suppressStaleStopNotifications = false
            val policy = policyLocked()
            val current = strength(channel)
            val next = if (current == 0) policy.coldStart(channel, requestedStrength) else policy.absoluteStrength(channel, requestedStrength)
            setStrengthLocked(channel, next)
            waves[channel] = WavePlayback(CoyoteWaveforms.byId(waveformId), 0, loop, true)
            emitStateLocked()
            CommandOutcome(true, if (next == requestedStrength) "applied" else "strength_clamped")
        }

    fun adjust(channel: CoyoteChannel, requestedDelta: Int): CommandOutcome = synchronized(lock) {
        if (!ready) return CommandOutcome(false, "coyote_not_connected")
        suppressStaleStopNotifications = false
        val policy = policyLocked()
        val current = strength(channel)
        if (current <= 0 || waves[channel]?.active != true) return CommandOutcome(false, "coyote_channel_not_running")
        val target = policy.targetStrength(channel, current, requestedDelta)
        setStrengthLocked(channel, target)
        emitStateLocked()
        CommandOutcome(true, if (target - current == requestedDelta) "applied" else "strength_clamped")
    }

    fun changeWave(channel: CoyoteChannel, waveformId: String, loop: Boolean = true): CommandOutcome = synchronized(lock) {
        if (!ready) return CommandOutcome(false, "coyote_not_connected")
        suppressStaleStopNotifications = false
        if (strength(channel) <= 0 || waves[channel]?.active != true) return CommandOutcome(false, "coyote_channel_not_running")
        waves[channel] = WavePlayback(CoyoteWaveforms.byId(waveformId), 0, loop, true)
        emitStateLocked()
        CommandOutcome(true, "applied")
    }

    fun stop(channel: CoyoteChannel? = null): CommandOutcome = synchronized(lock) {
        if (channel == null) {
            stopChannelLocked(CoyoteChannel.A)
            stopChannelLocked(CoyoteChannel.B)
        } else {
            stopChannelLocked(channel)
        }
        emitStateLocked()
        CommandOutcome(true, if (ready) "applied" else "already_disconnected")
    }

    fun emergencyStop(): CommandOutcome = synchronized(lock) {
        suppressStaleStopNotifications = true
        strengthA = 0
        strengthB = 0
        waves[CoyoteChannel.A] = WavePlayback()
        waves[CoyoteChannel.B] = WavePlayback()
        pendingMode = 0
        awaitingAck = false
        sequence = 0
        writeQueue.clear()
        val characteristic = if (generation == CoyoteGeneration.V3) writeCharacteristic else v2StrengthCharacteristic
        val packet = if (generation == CoyoteGeneration.V3) {
            CoyoteProtocolCodec.encodeV3EmergencyStop()
        } else {
            CoyoteProtocolCodec.encodeV2Strength(0, 0)
        }
        enqueueWriteLocked(characteristic, packet, front = true)
        emitStateLocked()
        CommandOutcome(true, if (ready) "applied" else "already_disconnected")
    }

    fun executeRemote(command: JSONObject): JSONObject {
        val action = command.optString("action")
        val isStop = action == "stop" || action == "emergency_stop"
        if (!isStop && preferences?.coyoteRemoteControlEnabled != true) {
            return commandResult(false, "remote_control_not_enabled")
        }
        val channel = if (command.optString("channel") == "B") CoyoteChannel.B else CoyoteChannel.A
        val outcome = when (action) {
            "start" -> start(
                channel,
                command.optInt("strength", 0).coerceIn(0, CoyoteSafetyPolicy.COLD_START_LIMIT),
                command.optString("waveform", "pulse_mid"),
                command.strictBoolean("loop", true),
            )
            "adjust" -> adjust(
                channel,
                command.optInt("delta", 0).coerceIn(-CoyoteSafetyPolicy.ADJUST_STEP_LIMIT, CoyoteSafetyPolicy.ADJUST_STEP_LIMIT),
            )
            "change_wave" -> changeWave(
                channel,
                command.optString("waveform", "pulse_mid"),
                command.strictBoolean("loop", true),
            )
            "stop" -> stop(if (command.has("channel")) channel else null)
            "emergency_stop" -> emergencyStop()
            else -> CommandOutcome(false, "unsupported_coyote_action")
        }
        return commandResult(outcome.ok, outcome.reason)
    }

    private fun commandResult(ok: Boolean, reason: String): JSONObject = JSONObject().apply {
        put("ok", ok)
        put("status", if (ok) "applied" else "failed")
        put("reason", reason)
        put("coyote", state.value.toJson())
    }

    @SuppressLint("MissingPermission")
    private fun stopScanLocked() {
        mainHandler.removeCallbacks(scanTimeout)
        runCatching { adapter?.bluetoothLeScanner?.stopScan(scanCallback) }
        if (mutableState.value.scanning) mutableState.value = mutableState.value.copy(scanning = false)
    }

    @SuppressLint("MissingPermission")
    private fun closeGattLocked(sendEmergencyStop: Boolean) {
        val closingGatt = gatt
        if (sendEmergencyStop && ready && closingGatt != null) {
            writeEmergencyDirectLocked(closingGatt)
        }
        ready = false
        setupStarted = false
        tickFuture?.cancel(false)
        tickFuture = null
        writeQueue.clear()
        currentWrite = null
        notificationQueue.clear()
        currentNotification = null
        gatt = null
        clearCharacteristicsLocked()
        strengthA = 0
        strengthB = 0
        waves[CoyoteChannel.A] = WavePlayback()
        waves[CoyoteChannel.B] = WavePlayback()
        mutableState.value = mutableState.value.copy(
            connecting = false,
            connected = false,
            strengthA = 0,
            strengthB = 0,
            waveActiveA = false,
            waveActiveB = false,
            waveformA = "",
            waveformB = "",
        )
        if (closingGatt != null) {
            val closePhysicalGatt = Runnable {
                runCatching { closingGatt.disconnect() }
                runCatching { closingGatt.close() }
            }
            if (sendEmergencyStop) mainHandler.postDelayed(closePhysicalGatt, 250L) else closePhysicalGatt.run()
        }
    }

    @SuppressLint("MissingPermission")
    private fun writeEmergencyDirectLocked(currentGatt: BluetoothGatt) {
        val characteristic = (if (generation == CoyoteGeneration.V3) writeCharacteristic else v2StrengthCharacteristic)
            ?: return
        val packet = if (generation == CoyoteGeneration.V3) {
            CoyoteProtocolCodec.encodeV3EmergencyStop()
        } else {
            CoyoteProtocolCodec.encodeV2Strength(0, 0)
        }
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                currentGatt.writeCharacteristic(
                    characteristic,
                    packet,
                    BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
                )
            } else {
                @Suppress("DEPRECATION")
                characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                @Suppress("DEPRECATION")
                characteristic.value = packet
                @Suppress("DEPRECATION")
                currentGatt.writeCharacteristic(characteristic)
            }
        }
    }

    private fun clearCharacteristicsLocked() {
        writeCharacteristic = null
        notifyCharacteristic = null
        batteryCharacteristic = null
        v2StrengthCharacteristic = null
        v2WaveACharacteristic = null
        v2WaveBCharacteristic = null
    }

    @SuppressLint("MissingPermission")
    private fun configureServicesLocked(currentGatt: BluetoothGatt): Boolean {
        clearCharacteristicsLocked()
        notificationQueue.clear()
        return when (generation) {
            CoyoteGeneration.V3 -> {
                val primary = currentGatt.getService(V3_PRIMARY_SERVICE)
                writeCharacteristic = primary?.getCharacteristic(V3_WRITE_CHAR)
                notifyCharacteristic = primary?.getCharacteristic(V3_NOTIFY_CHAR)
                if (writeCharacteristic == null || notifyCharacteristic == null) return failLocked("郊狼 V3 GATT 特征不完整")
                notificationQueue.add(NotificationTarget(notifyCharacteristic!!, required = true))
                optionalNotify(currentGatt, V3_LEGACY_SERVICE, V3_LEGACY_NOTIFY)?.let(notificationQueue::add)
                optionalNotify(currentGatt, V3_OTA_SERVICE, V3_OTA_NOTIFY)?.let(notificationQueue::add)
                batteryCharacteristic = currentGatt.getService(BATTERY_SERVICE)?.getCharacteristic(BATTERY_CHAR)
                enableNextNotificationLocked(currentGatt)
                true
            }
            CoyoteGeneration.V2 -> {
                val primary = currentGatt.getService(V2_PRIMARY_SERVICE)
                v2StrengthCharacteristic = primary?.getCharacteristic(V2_STRENGTH_CHAR)
                v2WaveACharacteristic = primary?.getCharacteristic(V2_WAVE_A_CHAR)
                v2WaveBCharacteristic = primary?.getCharacteristic(V2_WAVE_B_CHAR)
                if (v2StrengthCharacteristic == null || v2WaveACharacteristic == null || v2WaveBCharacteristic == null) {
                    return failLocked("郊狼 V2 GATT 特征不完整")
                }
                notificationQueue.add(NotificationTarget(v2StrengthCharacteristic!!, required = true))
                batteryCharacteristic = currentGatt.getService(V2_BATTERY_SERVICE)?.getCharacteristic(V2_BATTERY_CHAR)
                enableNextNotificationLocked(currentGatt)
                true
            }
            CoyoteGeneration.UNKNOWN -> failLocked("未知郊狼协议")
        }
    }

    private fun optionalNotify(gatt: BluetoothGatt, serviceId: UUID, characteristicId: UUID): NotificationTarget? =
        gatt.getService(serviceId)?.getCharacteristic(characteristicId)?.let { NotificationTarget(it, required = false) }

    @SuppressLint("MissingPermission")
    private fun enableNextNotificationLocked(currentGatt: BluetoothGatt) {
        val target = notificationQueue.pollFirst()
        if (target == null) {
            beginSetupAfterNotificationsLocked(currentGatt)
            return
        }
        currentNotification = target
        if (!currentGatt.setCharacteristicNotification(target.characteristic, true)) {
            if (target.required) {
                failConnectionLocked("无法启用郊狼通知")
                return
            }
            currentNotification = null
            enableNextNotificationLocked(currentGatt)
            return
        }
        val descriptor = target.characteristic.getDescriptor(CLIENT_CONFIG_DESCRIPTOR)
        if (descriptor == null || !writeDescriptor(currentGatt, descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
            if (target.required) {
                failConnectionLocked("郊狼通知描述符不可用")
                return
            }
            currentNotification = null
            enableNextNotificationLocked(currentGatt)
        }
    }

    @SuppressLint("MissingPermission")
    private fun beginSetupAfterNotificationsLocked(currentGatt: BluetoothGatt) {
        if (generation == CoyoteGeneration.V3) {
            if (!currentGatt.requestMtu(144)) beginV3SetupLocked()
            mainHandler.postDelayed({
                synchronized(lock) {
                    if (gatt === currentGatt) beginV3SetupLocked()
                }
            }, 1_500L)
        } else {
            enqueueWriteLocked(v2StrengthCharacteristic, CoyoteProtocolCodec.encodeV2Strength(0, 0)) {
                markReadyLocked()
            }
        }
    }

    private fun beginV3SetupLocked() {
        if (setupStarted || gatt == null || generation != CoyoteGeneration.V3) return
        setupStarted = true
        val policy = policyLocked()
        enqueueWriteLocked(writeCharacteristic, CoyoteProtocolCodec.v3InitPacket)
        enqueueWriteLocked(writeCharacteristic, CoyoteProtocolCodec.encodeV3Limits(policy.limitA, policy.limitB)) {
            pendingMode = 0x0f
            markReadyLocked()
        }
    }

    @SuppressLint("MissingPermission")
    private fun markReadyLocked() {
        ready = true
        mutableState.value = mutableState.value.copy(connecting = false, connected = true, error = "")
        batteryCharacteristic?.let { runCatching { gatt?.readCharacteristic(it) } }
        tickFuture?.cancel(false)
        tickFuture = tickExecutor.scheduleAtFixedRate(::protocolTick, 250L, TICK_MS, TimeUnit.MILLISECONDS)
        emitStateLocked()
        DebugLog.log("郊狼", "已连接 ${mutableState.value.deviceName} (${generation.name})")
    }

    private fun protocolTick() {
        synchronized(lock) {
            if (!ready || currentWrite != null || writeQueue.isNotEmpty()) return
            if (generation == CoyoteGeneration.V3) {
                val mode = if (!awaitingAck && pendingMode != 0) {
                    sequence = if (sequence >= 15) 1 else sequence + 1
                    awaitingAck = true
                    pendingMode.also { pendingMode = 0 }
                } else {
                    0
                }
                enqueueWriteLocked(
                    writeCharacteristic,
                    CoyoteProtocolCodec.encodeV3Control(
                        sequence = sequence,
                        mode = mode,
                        strengthA = strengthA,
                        strengthB = strengthB,
                        channelA = nextWaveStepsLocked(CoyoteChannel.A, 4),
                        channelB = nextWaveStepsLocked(CoyoteChannel.B, 4),
                    ),
                )
            } else if (generation == CoyoteGeneration.V2) {
                val policy = policyLocked()
                strengthA = strengthA.coerceAtMost(policy.limitA)
                strengthB = strengthB.coerceAtMost(policy.limitB)
                enqueueWriteLocked(v2StrengthCharacteristic, CoyoteProtocolCodec.encodeV2Strength(strengthA, strengthB))
                // V2 waveform characteristics are crossed: PWM_B drives A and PWM_A drives B.
                enqueueWriteLocked(v2WaveBCharacteristic, CoyoteProtocolCodec.encodeV2Wave(nextWaveStepsLocked(CoyoteChannel.A, 1).firstOrNull()))
                enqueueWriteLocked(v2WaveACharacteristic, CoyoteProtocolCodec.encodeV2Wave(nextWaveStepsLocked(CoyoteChannel.B, 1).firstOrNull()))
            }
        }
    }

    private fun nextWaveStepsLocked(channel: CoyoteChannel, count: Int): List<CoyoteWaveStep> {
        val playback = waves[channel] ?: return emptyList()
        if (!playback.active || playback.waveform == null || playback.waveform.frames.isEmpty()) return emptyList()
        val out = mutableListOf<CoyoteWaveStep>()
        repeat(count) {
            if (!playback.active) return@repeat
            if (playback.index >= playback.waveform.frames.size) {
                if (playback.loop) playback.index = 0 else playback.active = false
            }
            if (!playback.active) return@repeat
            out += playback.waveform.frames[playback.index]
            playback.index += 1
            if (playback.index >= playback.waveform.frames.size && !playback.loop) playback.active = false
        }
        return out
    }

    private fun setStrengthLocked(channel: CoyoteChannel, value: Int) {
        val next = value.coerceIn(0, policyLocked().limit(channel))
        if (channel == CoyoteChannel.A) strengthA = next else strengthB = next
        if (generation == CoyoteGeneration.V3) {
            if (channel == CoyoteChannel.A) {
                pendingMode = (pendingMode and 0x03) or (3 shl 2)
            } else {
                pendingMode = (pendingMode and 0x0c) or 3
            }
        }
    }

    private fun stopChannelLocked(channel: CoyoteChannel) {
        suppressStaleStopNotifications = true
        if (channel == CoyoteChannel.A) strengthA = 0 else strengthB = 0
        waves[channel] = WavePlayback()
        setStrengthLocked(channel, 0)
    }

    private fun strength(channel: CoyoteChannel): Int = if (channel == CoyoteChannel.A) strengthA else strengthB

    private fun policyLocked(): CoyoteSafetyPolicy {
        val prefs = preferences
        return CoyoteSafetyPolicy(
            maxStrengthA = prefs?.coyoteLimitA ?: CoyoteSafetyPolicy.DEFAULT_USER_LIMIT,
            maxStrengthB = prefs?.coyoteLimitB ?: CoyoteSafetyPolicy.DEFAULT_USER_LIMIT,
        )
    }

    private fun emitStateLocked() {
        val policy = policyLocked()
        val waveA = waves[CoyoteChannel.A] ?: WavePlayback()
        val waveB = waves[CoyoteChannel.B] ?: WavePlayback()
        mutableState.value = mutableState.value.copy(
            available = adapter != null,
            connected = ready,
            generation = generation,
            strengthA = strengthA,
            strengthB = strengthB,
            limitA = policy.limitA,
            limitB = policy.limitB,
            waveActiveA = waveA.active,
            waveActiveB = waveB.active,
            waveformA = waveA.waveform?.id.orEmpty(),
            waveformB = waveB.waveform?.id.orEmpty(),
            remoteControlEnabled = preferences?.coyoteRemoteControlEnabled == true,
            discoveredDevices = scanResults.values.sortedByDescending(ScannedCoyote::rssi),
        )
    }

    private fun failLocked(message: String): Boolean {
        mutableState.value = mutableState.value.copy(error = message.take(240), connecting = false)
        DebugLog.log("郊狼", message.take(240))
        return false
    }

    private fun failConnectionLocked(message: String) {
        failLocked(message)
        closeGattLocked(sendEmergencyStop = false)
    }

    private fun enqueueWriteLocked(
        characteristic: BluetoothGattCharacteristic?,
        value: ByteArray,
        front: Boolean = false,
        onComplete: (() -> Unit)? = null,
    ) {
        if (characteristic == null || gatt == null) return
        val pending = PendingWrite(characteristic, value.copyOf(), onComplete)
        if (front) writeQueue.addFirst(pending) else writeQueue.addLast(pending)
        drainWriteQueueLocked()
    }

    @SuppressLint("MissingPermission")
    private fun drainWriteQueueLocked() {
        if (currentWrite != null) return
        val currentGatt = gatt ?: return
        val pending = writeQueue.pollFirst() ?: return
        currentWrite = pending
        val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            currentGatt.writeCharacteristic(
                pending.characteristic,
                pending.value,
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
            ) == BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            pending.characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            @Suppress("DEPRECATION")
            pending.characteristic.value = pending.value
            @Suppress("DEPRECATION")
            currentGatt.writeCharacteristic(pending.characteristic)
        }
        if (!started) {
            currentWrite = null
            failConnectionLocked("郊狼 GATT 写入启动失败")
        }
    }

    @SuppressLint("MissingPermission")
    private fun writeDescriptor(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, value: ByteArray): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(descriptor, value) == BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            descriptor.value = value
            @Suppress("DEPRECATION")
            gatt.writeDescriptor(descriptor)
        }

    private fun handleNotificationLocked(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
        if (characteristic.uuid == V3_NOTIFY_CHAR && value.size >= 4 && value[0] == 0xb1.toByte()) {
            val ackSequence = value[1].toInt() and 0xff
            val nextStrengthA = value[2].toInt() and 0xff
            val nextStrengthB = value[3].toInt() and 0xff
            if (suppressStaleStopNotifications && (nextStrengthA > 0 || nextStrengthB > 0)) return
            strengthA = nextStrengthA
            strengthB = nextStrengthB
            if (awaitingAck && ackSequence == sequence) {
                awaitingAck = false
                sequence = 0
            }
            emitStateLocked()
        } else if (characteristic.uuid == V2_STRENGTH_CHAR && value.size >= 3) {
            val raw = (value[0].toInt() and 0xff) or
                ((value[1].toInt() and 0xff) shl 8) or
                ((value[2].toInt() and 0xff) shl 16)
            val nextStrengthA = (((raw shr 11) and 0x7ff) * 200.0 / 2047.0).toInt()
            val nextStrengthB = ((raw and 0x7ff) * 200.0 / 2047.0).toInt()
            if (suppressStaleStopNotifications && (nextStrengthA > 0 || nextStrengthB > 0)) return
            strengthA = nextStrengthA
            strengthB = nextStrengthB
            emitStateLocked()
        }
    }

    private val scanCallback = object : ScanCallback() {
        @SuppressLint("MissingPermission")
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val name = result.scanRecord?.deviceName.orEmpty().ifBlank {
                runCatching { result.device.name.orEmpty() }.getOrDefault("")
            }
            val detected = detectGeneration(name)
            if (detected == CoyoteGeneration.UNKNOWN) return
            synchronized(lock) {
                scanResults[result.device.address] = ScannedCoyote(result.device.address, name, result.rssi, detected)
                emitStateLocked()
            }
        }

        override fun onScanFailed(errorCode: Int) {
            synchronized(lock) {
                mutableState.value = mutableState.value.copy(scanning = false, error = "蓝牙扫描失败: $errorCode")
            }
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(currentGatt: BluetoothGatt, status: Int, newState: Int) {
            synchronized(lock) {
                if (currentGatt !== gatt) return
                if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                    if (!currentGatt.discoverServices()) failConnectionLocked("郊狼 GATT 服务发现启动失败")
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    failConnectionLocked("郊狼蓝牙连接已断开")
                }
            }
        }

        override fun onServicesDiscovered(currentGatt: BluetoothGatt, status: Int) {
            synchronized(lock) {
                if (currentGatt !== gatt) return
                if (status != BluetoothGatt.GATT_SUCCESS) failConnectionLocked("郊狼 GATT 服务发现失败")
                else configureServicesLocked(currentGatt)
            }
        }

        override fun onDescriptorWrite(currentGatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            synchronized(lock) {
                if (currentGatt !== gatt) return
                val target = currentNotification
                currentNotification = null
                if (status != BluetoothGatt.GATT_SUCCESS && target?.required == true) {
                    failConnectionLocked("郊狼通知订阅失败")
                } else {
                    enableNextNotificationLocked(currentGatt)
                }
            }
        }

        override fun onMtuChanged(currentGatt: BluetoothGatt, mtu: Int, status: Int) {
            synchronized(lock) {
                if (currentGatt === gatt) beginV3SetupLocked()
            }
        }

        override fun onCharacteristicWrite(
            currentGatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            synchronized(lock) {
                if (currentGatt !== gatt) return
                val completed = currentWrite
                currentWrite = null
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    failConnectionLocked("郊狼 GATT 写入失败: $status")
                    return
                }
                completed?.onComplete?.invoke()
                drainWriteQueueLocked()
            }
        }

        @Deprecated("Deprecated in Android 13")
        override fun onCharacteristicChanged(currentGatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            val value = characteristic.value ?: return
            synchronized(lock) { if (currentGatt === gatt) handleNotificationLocked(characteristic, value) }
        }

        override fun onCharacteristicChanged(
            currentGatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            synchronized(lock) { if (currentGatt === gatt) handleNotificationLocked(characteristic, value) }
        }

        @Deprecated("Deprecated in Android 13")
        override fun onCharacteristicRead(
            currentGatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            @Suppress("DEPRECATION")
            val value = characteristic.value ?: return
            handleBatteryRead(currentGatt, characteristic, value, status)
        }

        override fun onCharacteristicRead(
            currentGatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            handleBatteryRead(currentGatt, characteristic, value, status)
        }
    }

    private fun handleBatteryRead(
        currentGatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
        status: Int,
    ) {
        synchronized(lock) {
            if (currentGatt !== gatt || characteristic.uuid != BATTERY_CHAR || status != BluetoothGatt.GATT_SUCCESS) return
            val percent = value.firstOrNull()?.toInt()?.and(0xff)?.coerceIn(0, 100) ?: return
            mutableState.value = mutableState.value.copy(batteryPercent = percent)
        }
    }

    private fun hasScanPermission(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
        } else {
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        }

    private fun hasConnectPermission(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    private fun detectGeneration(name: String): CoyoteGeneration = when {
        name.startsWith(V3_NAME_PREFIX) -> CoyoteGeneration.V3
        name.startsWith(V2_NAME_PREFIX) -> CoyoteGeneration.V2
        else -> CoyoteGeneration.UNKNOWN
    }

    private fun JSONObject.strictBoolean(key: String, fallback: Boolean): Boolean =
        if (!has(key) || isNull(key)) fallback else opt(key) as? Boolean ?: false

    private data class PendingWrite(
        val characteristic: BluetoothGattCharacteristic,
        val value: ByteArray,
        val onComplete: (() -> Unit)?,
    )

    private data class NotificationTarget(
        val characteristic: BluetoothGattCharacteristic,
        val required: Boolean,
    )

    private data class WavePlayback(
        val waveform: CoyoteWaveform? = null,
        var index: Int = 0,
        val loop: Boolean = false,
        var active: Boolean = false,
    )

    data class CommandOutcome(val ok: Boolean, val reason: String)

    private val BluetoothDeviceTransport: Int = android.bluetooth.BluetoothDevice.TRANSPORT_LE

    private fun uuid(short: String): UUID = UUID.fromString(short)
    private fun v2Uuid(short: String): UUID = uuid("955a${short}-0fe2-f5aa-a094-84b8d4f3e8ad")

    private val CLIENT_CONFIG_DESCRIPTOR = uuid("00002902-0000-1000-8000-00805f9b34fb")
    private val BATTERY_SERVICE = uuid("0000180f-0000-1000-8000-00805f9b34fb")
    private val BATTERY_CHAR = uuid("00002a19-0000-1000-8000-00805f9b34fb")
    private val V3_PRIMARY_SERVICE = uuid("0000180c-0000-1000-8000-00805f9b34fb")
    private val V3_WRITE_CHAR = uuid("0000150a-0000-1000-8000-00805f9b34fb")
    private val V3_NOTIFY_CHAR = uuid("0000150b-0000-1000-8000-00805f9b34fb")
    private val V3_LEGACY_SERVICE = uuid("0000ff0a-0000-1000-8000-00805f9b34fb")
    private val V3_LEGACY_NOTIFY = uuid("0000ff00-0000-1000-8000-00805f9b34fb")
    private val V3_OTA_SERVICE = uuid("f000ffc0-0451-4000-b000-000000000000")
    private val V3_OTA_NOTIFY = uuid("f000ffc2-0451-4000-b000-000000000000")
    private val V2_PRIMARY_SERVICE = v2Uuid("180b")
    private val V2_STRENGTH_CHAR = v2Uuid("1504")
    private val V2_WAVE_A_CHAR = v2Uuid("1505")
    private val V2_WAVE_B_CHAR = v2Uuid("1506")
    private val V2_BATTERY_SERVICE = v2Uuid("180a")
    private val V2_BATTERY_CHAR = v2Uuid("1500")
}
