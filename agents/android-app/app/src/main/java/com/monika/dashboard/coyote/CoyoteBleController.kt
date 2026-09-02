package com.monika.dashboard.coyote

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
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.R
import com.monika.dashboard.integration.AndroidIntegrationPreferences
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

object CoyoteBleController {
    private const val SCAN_DURATION_MS = 10_000L
    private const val TICK_MS = 100L

    private val mainHandler = Handler(Looper.getMainLooper())
    private val tickExecutor = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "coyote-protocol").apply { isDaemon = true }
    }
    private val lock = Any()
    private val mutableState = MutableStateFlow(CoyoteDeviceState())
    private val protocolCommitSerial = MutableStateFlow(0L)
    val state: StateFlow<CoyoteDeviceState> = mutableState.asStateFlow()

    private var appContext: Context? = null
    private var preferences: AndroidIntegrationPreferences? = null
    private var adapter: BluetoothAdapter? = null
    private var gatt: BluetoothGatt? = null
    private var generation = CoyoteGeneration.UNKNOWN
    private var ready = false
    private var setupStarted = false
    private var protocolWriteInFlight = false
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

    private val protocolRuntime = CoyoteProtocolRuntime()
    private val scanResults = linkedMapOf<String, ScannedCoyote>()
    private val scanTimeout = Runnable { stopScan() }

    fun initialize(context: Context) {
        synchronized(lock) {
            if (appContext != null) return
            appContext = context.applicationContext
            preferences = AndroidIntegrationPreferences(context)
            preferences?.coyoteRemoteControlEnabled = false
            adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
            emitStateLocked()
        }
    }

    @SuppressLint("MissingPermission")
    fun startScan(): Boolean = synchronized(lock) {
        val context = appContext ?: return false
        val bluetoothAdapter = adapter ?: return failLocked(message(R.string.coyote_error_no_adapter))
        if (!CoyoteGattProfile.hasScanPermission(context)) return failLocked(message(R.string.coyote_error_scan_permission))
        if (!bluetoothAdapter.isEnabled) return failLocked(message(R.string.coyote_error_enable_bluetooth))
        stopScanLocked()
        scanResults.clear()
        mutableState.value = mutableState.value.copy(scanning = true, discoveredDevices = emptyList(), error = "")
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        return runCatching {
            bluetoothAdapter.bluetoothLeScanner.startScan(null, settings, scanCallback)
            mainHandler.postDelayed(scanTimeout, SCAN_DURATION_MS)
            true
        }.getOrElse { error -> failLocked(message(R.string.coyote_error_scan_start, error.message.orEmpty())) }
    }

    @SuppressLint("MissingPermission")
    fun stopScan() {
        synchronized(lock) { stopScanLocked() }
    }

    @SuppressLint("MissingPermission")
    fun connect(address: String): Boolean = synchronized(lock) {
        val context = appContext ?: return false
        val bluetoothAdapter = adapter ?: return failLocked(message(R.string.coyote_error_no_adapter))
        if (!CoyoteGattProfile.hasConnectPermission(context)) return failLocked(message(R.string.coyote_error_connect_permission))
        stopScanLocked()
        closeGattLocked(sendEmergencyStop = true)
        val device = runCatching { bluetoothAdapter.getRemoteDevice(address) }.getOrNull()
            ?: return failLocked(message(R.string.coyote_error_invalid_address))
        val name = scanResults[address]?.name
            ?: runCatching { device.name.orEmpty() }.getOrDefault("")
        generation = CoyoteGattProfile.detectGeneration(name)
        if (generation == CoyoteGeneration.UNKNOWN) return failLocked(message(R.string.coyote_error_unsupported_device))
        protocolRuntime.reset(generation)
        mutableState.value = mutableState.value.copy(
            connecting = true,
            connected = false,
            deviceName = name,
            address = address,
            generation = generation,
            error = "",
        )
        return runCatching {
            val createdGatt = device.connectGatt(context, false, gattCallback, CoyoteGattProfile.TRANSPORT_LE)
            gatt = createdGatt
            if (createdGatt == null) failLocked(message(R.string.coyote_error_connect, "GATT")) else true
        }.getOrElse { error -> failLocked(message(R.string.coyote_error_connect, error.message.orEmpty())) }
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
            protocolRuntime.clampTo(policy)
            if (ready && generation == CoyoteGeneration.V3) {
                enqueueWriteLocked(writeCharacteristic, CoyoteProtocolCodec.encodeV3Limits(policy.limitA, policy.limitB))
            }
            emitStateLocked()
        }
    }

    fun start(channel: CoyoteChannel, requestedStrength: Int, waveformId: String, loop: Boolean = true): CoyoteCommandOutcome =
        synchronized(lock) {
            if (!ready) return CoyoteCommandOutcome(false, "coyote_not_connected")
            val policy = policyLocked()
            val mutation = protocolRuntime.start(channel, requestedStrength, waveformId, loop, policy)
            emitStateLocked()
            CoyoteCommandOutcome(mutation.ok, mutation.reason, commandCommitThresholdLocked().takeIf { mutation.ok })
        }

    fun adjust(channel: CoyoteChannel, requestedDelta: Int): CoyoteCommandOutcome = synchronized(lock) {
        if (!ready) return CoyoteCommandOutcome(false, "coyote_not_connected")
        val policy = policyLocked()
        val mutation = protocolRuntime.adjust(channel, requestedDelta, policy)
        emitStateLocked()
        CoyoteCommandOutcome(mutation.ok, mutation.reason, commandCommitThresholdLocked().takeIf { mutation.ok })
    }

    fun changeWave(channel: CoyoteChannel, waveformId: String, loop: Boolean = true): CoyoteCommandOutcome = synchronized(lock) {
        if (!ready) return CoyoteCommandOutcome(false, "coyote_not_connected")
        val mutation = protocolRuntime.changeWave(channel, waveformId, loop)
        emitStateLocked()
        CoyoteCommandOutcome(mutation.ok, mutation.reason, commandCommitThresholdLocked().takeIf { mutation.ok })
    }

    fun stop(channel: CoyoteChannel? = null): CoyoteCommandOutcome = synchronized(lock) {
        protocolRuntime.stop(channel)
        emitStateLocked()
        CoyoteCommandOutcome(true, if (ready) "applied" else "already_disconnected", commandCommitThresholdLocked().takeIf { ready })
    }

    fun emergencyStop(): CoyoteCommandOutcome = synchronized(lock) {
        protocolRuntime.emergencyStop()
        writeQueue.clear()
        val characteristic = if (generation == CoyoteGeneration.V3) writeCharacteristic else v2StrengthCharacteristic
        val packet = if (generation == CoyoteGeneration.V3) {
            CoyoteProtocolCodec.encodeV3EmergencyStop()
        } else {
            CoyoteProtocolCodec.encodeV2Strength(0, 0)
        }
        enqueueWriteLocked(characteristic, packet, front = true) { recordProtocolWriteLocked() }
        emitStateLocked()
        CoyoteCommandOutcome(true, if (ready) "applied" else "already_disconnected", commandCommitThresholdLocked().takeIf { ready })
    }

    suspend fun awaitPhysicalCommit(outcome: CoyoteCommandOutcome): CoyoteCommandOutcome {
        if (!outcome.ok || outcome.commitAfterSerial == null) return outcome
        val committed = withTimeoutOrNull(4_000L) {
            protocolCommitSerial.filter { it > outcome.commitAfterSerial }.first()
        } != null
        return if (committed) outcome else CoyoteCommandOutcome(false, "gatt_write_not_confirmed")
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
        protocolWriteInFlight = false
        tickFuture?.cancel(false)
        tickFuture = null
        writeQueue.clear()
        currentWrite = null
        notificationQueue.clear()
        currentNotification = null
        gatt = null
        preferences?.coyoteRemoteControlEnabled = false
        clearCharacteristicsLocked()
        protocolRuntime.reset(generation)
        mutableState.value = mutableState.value.copy(
            connecting = false,
            connected = false,
            strengthA = 0,
            strengthB = 0,
            waveActiveA = false,
            waveActiveB = false,
            waveformA = "",
            waveformB = "",
            remoteControlEnabled = false,
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
                val primary = currentGatt.getService(CoyoteGattProfile.V3_PRIMARY_SERVICE)
                writeCharacteristic = primary?.getCharacteristic(CoyoteGattProfile.V3_WRITE_CHAR)
                notifyCharacteristic = primary?.getCharacteristic(CoyoteGattProfile.V3_NOTIFY_CHAR)
                if (writeCharacteristic == null || notifyCharacteristic == null) return failLocked(message(R.string.coyote_error_v3_gatt))
                notificationQueue.add(NotificationTarget(notifyCharacteristic!!, required = true))
                optionalNotify(currentGatt, CoyoteGattProfile.V3_LEGACY_SERVICE, CoyoteGattProfile.V3_LEGACY_NOTIFY)?.let(notificationQueue::add)
                optionalNotify(currentGatt, CoyoteGattProfile.V3_OTA_SERVICE, CoyoteGattProfile.V3_OTA_NOTIFY)?.let(notificationQueue::add)
                batteryCharacteristic = currentGatt.getService(CoyoteGattProfile.BATTERY_SERVICE)
                    ?.getCharacteristic(CoyoteGattProfile.BATTERY_CHAR)
                enableNextNotificationLocked(currentGatt)
                true
            }
            CoyoteGeneration.V2 -> {
                val primary = currentGatt.getService(CoyoteGattProfile.V2_PRIMARY_SERVICE)
                v2StrengthCharacteristic = primary?.getCharacteristic(CoyoteGattProfile.V2_STRENGTH_CHAR)
                v2WaveACharacteristic = primary?.getCharacteristic(CoyoteGattProfile.V2_WAVE_A_CHAR)
                v2WaveBCharacteristic = primary?.getCharacteristic(CoyoteGattProfile.V2_WAVE_B_CHAR)
                if (v2StrengthCharacteristic == null || v2WaveACharacteristic == null || v2WaveBCharacteristic == null) {
                    return failLocked(message(R.string.coyote_error_v2_gatt))
                }
                notificationQueue.add(NotificationTarget(v2StrengthCharacteristic!!, required = true))
                batteryCharacteristic = currentGatt.getService(CoyoteGattProfile.V2_BATTERY_SERVICE)
                    ?.getCharacteristic(CoyoteGattProfile.V2_BATTERY_CHAR)
                enableNextNotificationLocked(currentGatt)
                true
            }
            CoyoteGeneration.UNKNOWN -> failLocked(message(R.string.coyote_error_unknown_protocol))
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
                failConnectionLocked(message(R.string.coyote_error_enable_notifications))
                return
            }
            currentNotification = null
            enableNextNotificationLocked(currentGatt)
            return
        }
        val descriptor = target.characteristic.getDescriptor(CoyoteGattProfile.CLIENT_CONFIG_DESCRIPTOR)
        if (descriptor == null || !writeDescriptor(currentGatt, descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
            if (target.required) {
                failConnectionLocked(message(R.string.coyote_error_notification_descriptor))
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
            protocolRuntime.prepareV3Control()
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
                protocolWriteInFlight = true
                enqueueWriteLocked(
                    writeCharacteristic,
                    protocolRuntime.nextV3Packet(policyLocked()),
                    onComplete = { recordProtocolWriteLocked() },
                )
            } else if (generation == CoyoteGeneration.V2) {
                protocolWriteInFlight = true
                val tick = protocolRuntime.nextV2Tick(policyLocked())
                enqueueWriteLocked(v2StrengthCharacteristic, tick.strength)
                enqueueWriteLocked(v2WaveBCharacteristic, tick.waveA)
                enqueueWriteLocked(
                    v2WaveACharacteristic,
                    tick.waveB,
                ) { recordProtocolWriteLocked() }
            }
        }
    }

    private fun policyLocked(): CoyoteSafetyPolicy {
        val prefs = preferences
        return CoyoteSafetyPolicy(
            maxStrengthA = prefs?.coyoteLimitA ?: CoyoteSafetyPolicy.DEFAULT_USER_LIMIT,
            maxStrengthB = prefs?.coyoteLimitB ?: CoyoteSafetyPolicy.DEFAULT_USER_LIMIT,
        )
    }

    private fun emitStateLocked() {
        val policy = policyLocked()
        val protocol = protocolRuntime.snapshot()
        mutableState.value = mutableState.value.copy(
            available = adapter != null,
            connected = ready,
            generation = generation,
            strengthA = protocol.strengthA,
            strengthB = protocol.strengthB,
            limitA = policy.limitA,
            limitB = policy.limitB,
            waveActiveA = protocol.waveActiveA,
            waveActiveB = protocol.waveActiveB,
            waveformA = protocol.waveformA,
            waveformB = protocol.waveformB,
            remoteControlEnabled = preferences?.coyoteRemoteControlEnabled == true,
            discoveredDevices = scanResults.values.sortedByDescending(ScannedCoyote::rssi),
        )
    }

    private fun recordProtocolWriteLocked() {
        protocolWriteInFlight = false
        protocolCommitSerial.value = protocolCommitSerial.value + 1L
    }

    private fun commandCommitThresholdLocked(): Long =
        protocolCommitSerial.value + if (protocolWriteInFlight) 1L else 0L

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
            failConnectionLocked(message(R.string.coyote_error_gatt_write_start))
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
        if (characteristic.uuid == CoyoteGattProfile.V3_NOTIFY_CHAR && value.size >= 4 && value[0] == 0xb1.toByte()) {
            if (protocolRuntime.handleV3Notification(value)) emitStateLocked()
        } else if (characteristic.uuid == CoyoteGattProfile.V2_STRENGTH_CHAR && value.size >= 3) {
            if (protocolRuntime.handleV2Notification(value)) emitStateLocked()
        }
    }

    private val scanCallback = object : ScanCallback() {
        @SuppressLint("MissingPermission")
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val name = result.scanRecord?.deviceName.orEmpty().ifBlank {
                runCatching { result.device.name.orEmpty() }.getOrDefault("")
            }
            val detected = CoyoteGattProfile.detectGeneration(name)
            if (detected == CoyoteGeneration.UNKNOWN) return
            synchronized(lock) {
                scanResults[result.device.address] = ScannedCoyote(result.device.address, name, result.rssi, detected)
                emitStateLocked()
            }
        }

        override fun onScanFailed(errorCode: Int) {
            synchronized(lock) {
                mutableState.value = mutableState.value.copy(
                    scanning = false,
                    error = message(R.string.coyote_error_scan_failed, errorCode),
                )
            }
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(currentGatt: BluetoothGatt, status: Int, newState: Int) {
            synchronized(lock) {
                if (currentGatt !== gatt) return
                if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                    if (!currentGatt.discoverServices()) failConnectionLocked(message(R.string.coyote_error_service_discovery_start))
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    failConnectionLocked(message(R.string.coyote_error_disconnected))
                }
            }
        }

        override fun onServicesDiscovered(currentGatt: BluetoothGatt, status: Int) {
            synchronized(lock) {
                if (currentGatt !== gatt) return
                if (status != BluetoothGatt.GATT_SUCCESS) failConnectionLocked(message(R.string.coyote_error_service_discovery))
                else configureServicesLocked(currentGatt)
            }
        }

        override fun onDescriptorWrite(currentGatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            synchronized(lock) {
                if (currentGatt !== gatt) return
                val target = currentNotification
                currentNotification = null
                if (status != BluetoothGatt.GATT_SUCCESS && target?.required == true) {
                    failConnectionLocked(message(R.string.coyote_error_notification_subscription))
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
                    failConnectionLocked(message(R.string.coyote_error_gatt_write, status))
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
            if (currentGatt !== gatt || characteristic.uuid != CoyoteGattProfile.BATTERY_CHAR || status != BluetoothGatt.GATT_SUCCESS) return
            val percent = value.firstOrNull()?.toInt()?.and(0xff)?.coerceIn(0, 100) ?: return
            mutableState.value = mutableState.value.copy(batteryPercent = percent)
        }
    }

    private fun message(resourceId: Int, vararg args: Any): String =
        appContext?.getString(resourceId, *args).orEmpty()

    private data class PendingWrite(
        val characteristic: BluetoothGattCharacteristic,
        val value: ByteArray,
        val onComplete: (() -> Unit)?,
    )

    private data class NotificationTarget(
        val characteristic: BluetoothGattCharacteristic,
        val required: Boolean,
    )

}
