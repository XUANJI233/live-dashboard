package com.monika.dashboard.coyote

import kotlin.math.roundToInt
import kotlin.math.sqrt

enum class CoyoteChannel { A, B }

enum class CoyoteGeneration { V2, V3, UNKNOWN }

data class CoyoteWaveStep(
    val frequency: Int,
    val intensity: Int,
)

data class CoyoteWaveform(
    val id: String,
    val displayName: String,
    val frames: List<CoyoteWaveStep>,
)

object CoyoteWaveforms {
    val all: List<CoyoteWaveform> = listOf(
        CoyoteWaveform(
            id = "breath",
            displayName = "呼吸",
            frames = listOf(0, 20, 40, 60, 80, 100, 100, 100, 0, 0, 0, 0)
                .map { CoyoteWaveStep(10, it) },
        ),
        CoyoteWaveform(
            id = "tide",
            displayName = "潮汐",
            frames = listOf(
                10 to 0, 11 to 16, 13 to 33, 14 to 50, 16 to 66, 18 to 83,
                19 to 100, 21 to 92, 22 to 84, 24 to 76, 26 to 68, 26 to 0,
                27 to 16, 29 to 33, 30 to 50, 32 to 66, 34 to 83, 35 to 100,
                37 to 92, 38 to 84, 40 to 76, 42 to 68,
            ).map { (frequency, intensity) -> CoyoteWaveStep(frequency, intensity) },
        ),
        CoyoteWaveform("pulse_low", "低脉冲", List(10) { CoyoteWaveStep(10, 30) }),
        CoyoteWaveform("pulse_mid", "中脉冲", List(10) { CoyoteWaveStep(10, 60) }),
        CoyoteWaveform("pulse_high", "高脉冲", List(10) { CoyoteWaveStep(10, 100) }),
        CoyoteWaveform(
            id = "tap",
            displayName = "敲击",
            frames = listOf(100, 0, 0, 100, 0, 0).map { CoyoteWaveStep(10, it) },
        ),
    )

    fun byId(id: String): CoyoteWaveform = all.firstOrNull { it.id == id } ?: all.first { it.id == "pulse_mid" }
}

object CoyoteProtocolCodec {
    val v3InitPacket: ByteArray = byteArrayOf(0x50, 0x02) + ByteArray(13)

    fun encodeV2Strength(strengthA: Int, strengthB: Int): ByteArray {
        val valueA = (strengthA.coerceIn(0, 200) * 2047.0 / 200.0).roundToInt()
        val valueB = (strengthB.coerceIn(0, 200) * 2047.0 / 200.0).roundToInt()
        val combined = (valueA shl 11) or valueB
        return byteArrayOf(
            (combined and 0xff).toByte(),
            ((combined shr 8) and 0xff).toByte(),
            ((combined shr 16) and 0xff).toByte(),
        )
    }

    fun encodeV2Wave(step: CoyoteWaveStep?): ByteArray {
        if (step == null) return byteArrayOf(0, 0, 0)
        val periodMs = decodeV3Frequency(step.frequency.coerceIn(10, 240))
        val x = (sqrt(periodMs / 1000.0) * 15.0).roundToInt().coerceIn(1, 31)
        val y = (periodMs - x).coerceIn(0, 1023)
        val z = (step.intensity.coerceIn(0, 100) * 31.0 / 100.0).roundToInt().coerceIn(0, 31)
        val packed = ((z and 0x1f) shl 15) or ((y and 0x3ff) shl 5) or (x and 0x1f)
        return byteArrayOf(
            (packed and 0xff).toByte(),
            ((packed shr 8) and 0xff).toByte(),
            ((packed shr 16) and 0xff).toByte(),
        )
    }

    fun encodeV3Control(
        sequence: Int,
        mode: Int,
        strengthA: Int,
        strengthB: Int,
        channelA: List<CoyoteWaveStep>,
        channelB: List<CoyoteWaveStep>,
    ): ByteArray = ByteArray(20).apply {
        this[0] = 0xb0.toByte()
        this[1] = (((sequence and 0x0f) shl 4) or (mode and 0x0f)).toByte()
        this[2] = strengthA.coerceIn(0, 200).toByte()
        this[3] = strengthB.coerceIn(0, 200).toByte()
        val framesA = v3Quad(channelA)
        val framesB = v3Quad(channelB)
        framesA.first.forEachIndexed { index, value -> this[4 + index] = value.toByte() }
        framesA.second.forEachIndexed { index, value -> this[8 + index] = value.toByte() }
        framesB.first.forEachIndexed { index, value -> this[12 + index] = value.toByte() }
        framesB.second.forEachIndexed { index, value -> this[16 + index] = value.toByte() }
    }

    fun encodeV3Limits(limitA: Int, limitB: Int): ByteArray = byteArrayOf(
        0xbf.toByte(),
        limitA.coerceIn(0, 200).toByte(),
        limitB.coerceIn(0, 200).toByte(),
        160.toByte(),
        160.toByte(),
        0,
        0,
    )

    fun encodeV3EmergencyStop(): ByteArray = encodeV3Control(
        sequence = 0,
        mode = 0x0f,
        strengthA = 0,
        strengthB = 0,
        channelA = emptyList(),
        channelB = emptyList(),
    )

    private fun v3Quad(frames: List<CoyoteWaveStep>): Pair<IntArray, IntArray> {
        if (frames.isEmpty()) return IntArray(4) to intArrayOf(0, 0, 0, 101)
        val frequencies = IntArray(4) { 10 }
        val intensities = IntArray(4)
        frames.take(4).forEachIndexed { index, frame ->
            frequencies[index] = frame.frequency.coerceIn(10, 240)
            intensities[index] = frame.intensity.coerceIn(0, 100)
        }
        return frequencies to intensities
    }

    private fun decodeV3Frequency(encoded: Int): Int = when {
        encoded <= 100 -> encoded
        encoded <= 200 -> (encoded - 100) * 5 + 100
        else -> (encoded - 200) * 10 + 600
    }
}
