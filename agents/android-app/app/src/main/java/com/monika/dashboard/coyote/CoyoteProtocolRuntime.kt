package com.monika.dashboard.coyote

data class CoyoteProtocolSnapshot(
    val strengthA: Int,
    val strengthB: Int,
    val waveActiveA: Boolean,
    val waveActiveB: Boolean,
    val waveformA: String,
    val waveformB: String,
)

data class CoyoteV2Tick(
    val strength: ByteArray,
    val waveA: ByteArray,
    val waveB: ByteArray,
)

data class CoyoteMutationResult(
    val ok: Boolean,
    val reason: String,
)

class CoyoteProtocolRuntime {
    private var generation = CoyoteGeneration.UNKNOWN
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

    fun reset(nextGeneration: CoyoteGeneration) {
        generation = nextGeneration
        strengthA = 0
        strengthB = 0
        sequence = 0
        pendingMode = 0
        awaitingAck = false
        suppressStaleStopNotifications = false
        waves[CoyoteChannel.A] = WavePlayback()
        waves[CoyoteChannel.B] = WavePlayback()
    }

    fun prepareV3Control() {
        pendingMode = 0x0f
    }

    fun clampTo(policy: CoyoteSafetyPolicy) {
        strengthA = strengthA.coerceAtMost(policy.limitA)
        strengthB = strengthB.coerceAtMost(policy.limitB)
    }

    fun start(
        channel: CoyoteChannel,
        requestedStrength: Int,
        waveformId: String,
        loop: Boolean,
        policy: CoyoteSafetyPolicy,
    ): CoyoteMutationResult {
        suppressStaleStopNotifications = false
        val current = strength(channel)
        val next = if (current == 0) {
            policy.coldStart(channel, requestedStrength)
        } else {
            policy.absoluteStrength(channel, requestedStrength)
        }
        setStrength(channel, next, policy)
        waves[channel] = WavePlayback(CoyoteWaveforms.byId(waveformId), 0, loop, true)
        return CoyoteMutationResult(true, if (next == requestedStrength) "applied" else "strength_clamped")
    }

    fun adjust(
        channel: CoyoteChannel,
        requestedDelta: Int,
        policy: CoyoteSafetyPolicy,
    ): CoyoteMutationResult {
        suppressStaleStopNotifications = false
        val current = strength(channel)
        if (current <= 0 || waves[channel]?.active != true) {
            return CoyoteMutationResult(false, "coyote_channel_not_running")
        }
        val target = policy.targetStrength(channel, current, requestedDelta)
        setStrength(channel, target, policy)
        return CoyoteMutationResult(
            true,
            if (target - current == requestedDelta) "applied" else "strength_clamped",
        )
    }

    fun changeWave(channel: CoyoteChannel, waveformId: String, loop: Boolean): CoyoteMutationResult {
        suppressStaleStopNotifications = false
        if (strength(channel) <= 0 || waves[channel]?.active != true) {
            return CoyoteMutationResult(false, "coyote_channel_not_running")
        }
        waves[channel] = WavePlayback(CoyoteWaveforms.byId(waveformId), 0, loop, true)
        return CoyoteMutationResult(true, "applied")
    }

    fun stop(channel: CoyoteChannel?) {
        suppressStaleStopNotifications = true
        if (channel == null) {
            stopChannel(CoyoteChannel.A)
            stopChannel(CoyoteChannel.B)
        } else {
            stopChannel(channel)
        }
    }

    fun emergencyStop() {
        suppressStaleStopNotifications = true
        strengthA = 0
        strengthB = 0
        waves[CoyoteChannel.A] = WavePlayback()
        waves[CoyoteChannel.B] = WavePlayback()
        pendingMode = 0
        awaitingAck = false
        sequence = 0
    }

    fun nextV3Packet(policy: CoyoteSafetyPolicy): ByteArray {
        clampTo(policy)
        val mode = if (!awaitingAck && pendingMode != 0) {
            sequence = if (sequence >= 15) 1 else sequence + 1
            awaitingAck = true
            pendingMode.also { pendingMode = 0 }
        } else {
            0
        }
        return CoyoteProtocolCodec.encodeV3Control(
            sequence = sequence,
            mode = mode,
            strengthA = strengthA,
            strengthB = strengthB,
            channelA = nextWaveSteps(CoyoteChannel.A, 4),
            channelB = nextWaveSteps(CoyoteChannel.B, 4),
        )
    }

    fun nextV2Tick(policy: CoyoteSafetyPolicy): CoyoteV2Tick {
        clampTo(policy)
        return CoyoteV2Tick(
            strength = CoyoteProtocolCodec.encodeV2Strength(strengthA, strengthB),
            // V2 waveform characteristics are crossed: PWM_B drives A and PWM_A drives B.
            waveA = CoyoteProtocolCodec.encodeV2Wave(nextWaveSteps(CoyoteChannel.A, 1).firstOrNull()),
            waveB = CoyoteProtocolCodec.encodeV2Wave(nextWaveSteps(CoyoteChannel.B, 1).firstOrNull()),
        )
    }

    fun handleV3Notification(value: ByteArray): Boolean {
        if (value.size < 4 || value[0] != 0xb1.toByte()) return false
        val ackSequence = value[1].toInt() and 0xff
        val nextStrengthA = value[2].toInt() and 0xff
        val nextStrengthB = value[3].toInt() and 0xff
        if (suppressStaleStopNotifications && (nextStrengthA > 0 || nextStrengthB > 0)) return false
        strengthA = nextStrengthA
        strengthB = nextStrengthB
        if (awaitingAck && ackSequence == sequence) {
            awaitingAck = false
            sequence = 0
        }
        return true
    }

    fun handleV2Notification(value: ByteArray): Boolean {
        if (value.size < 3) return false
        val raw = (value[0].toInt() and 0xff) or
            ((value[1].toInt() and 0xff) shl 8) or
            ((value[2].toInt() and 0xff) shl 16)
        val nextStrengthA = (((raw shr 11) and 0x7ff) * 200.0 / 2047.0).toInt()
        val nextStrengthB = ((raw and 0x7ff) * 200.0 / 2047.0).toInt()
        if (suppressStaleStopNotifications && (nextStrengthA > 0 || nextStrengthB > 0)) return false
        strengthA = nextStrengthA
        strengthB = nextStrengthB
        return true
    }

    fun snapshot(): CoyoteProtocolSnapshot {
        val waveA = waves[CoyoteChannel.A] ?: WavePlayback()
        val waveB = waves[CoyoteChannel.B] ?: WavePlayback()
        return CoyoteProtocolSnapshot(
            strengthA = strengthA,
            strengthB = strengthB,
            waveActiveA = waveA.active,
            waveActiveB = waveB.active,
            waveformA = waveA.waveform?.id.orEmpty(),
            waveformB = waveB.waveform?.id.orEmpty(),
        )
    }

    private fun setStrength(channel: CoyoteChannel, value: Int, policy: CoyoteSafetyPolicy) {
        val next = value.coerceIn(0, policy.limit(channel))
        if (channel == CoyoteChannel.A) strengthA = next else strengthB = next
        if (generation == CoyoteGeneration.V3) {
            if (channel == CoyoteChannel.A) {
                pendingMode = (pendingMode and 0x03) or (3 shl 2)
            } else {
                pendingMode = (pendingMode and 0x0c) or 3
            }
        }
    }

    private fun stopChannel(channel: CoyoteChannel) {
        if (channel == CoyoteChannel.A) strengthA = 0 else strengthB = 0
        waves[channel] = WavePlayback()
        setStrength(channel, 0, CoyoteSafetyPolicy(CoyoteSafetyPolicy.MAX_STRENGTH, CoyoteSafetyPolicy.MAX_STRENGTH))
    }

    private fun strength(channel: CoyoteChannel): Int = if (channel == CoyoteChannel.A) strengthA else strengthB

    private fun nextWaveSteps(channel: CoyoteChannel, count: Int): List<CoyoteWaveStep> {
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

    private data class WavePlayback(
        val waveform: CoyoteWaveform? = null,
        var index: Int = 0,
        val loop: Boolean = false,
        var active: Boolean = false,
    )
}
