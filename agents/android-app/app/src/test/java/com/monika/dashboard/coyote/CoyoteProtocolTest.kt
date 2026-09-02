package com.monika.dashboard.coyote

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class CoyoteProtocolTest {
    @Test
    fun `V2 strength encoding uses the little endian dual channel layout`() {
        assertArrayEquals(byteArrayOf(0, 0, 0), CoyoteProtocolCodec.encodeV2Strength(0, 0))
        assertArrayEquals(
            byteArrayOf(0xff.toByte(), 0xff.toByte(), 0x3f),
            CoyoteProtocolCodec.encodeV2Strength(200, 200),
        )
        assertArrayEquals(
            byteArrayOf(0, 0xf8.toByte(), 0x3f),
            CoyoteProtocolCodec.encodeV2Strength(200, 0),
        )
    }

    @Test
    fun `V3 packet includes absolute mode strengths and four waveform slots`() {
        val frames = listOf(
            CoyoteWaveStep(10, 20),
            CoyoteWaveStep(11, 40),
            CoyoteWaveStep(12, 60),
            CoyoteWaveStep(13, 80),
        )

        val packet = CoyoteProtocolCodec.encodeV3Control(
            sequence = 2,
            mode = 0x0f,
            strengthA = 8,
            strengthB = 9,
            channelA = frames,
            channelB = emptyList(),
        )

        assertEquals(20, packet.size)
        assertEquals(0xb0.toByte(), packet[0])
        assertEquals(0x2f.toByte(), packet[1])
        assertEquals(8, packet[2].toInt())
        assertEquals(9, packet[3].toInt())
        assertArrayEquals(byteArrayOf(10, 11, 12, 13), packet.copyOfRange(4, 8))
        assertArrayEquals(byteArrayOf(20, 40, 60, 80), packet.copyOfRange(8, 12))
        assertArrayEquals(byteArrayOf(0, 0, 0, 0), packet.copyOfRange(12, 16))
        assertArrayEquals(byteArrayOf(0, 0, 0, 101), packet.copyOfRange(16, 20))
    }

    @Test
    fun `remote policy clamps cold starts steps and absolute user limits`() {
        val policy = CoyoteSafetyPolicy(maxStrengthA = 30, maxStrengthB = 40)

        assertEquals(10, policy.coldStart(CoyoteChannel.A, 100))
        assertEquals(10, policy.adjustDelta(100))
        assertEquals(-10, policy.adjustDelta(-100))
        assertEquals(30, policy.targetStrength(CoyoteChannel.A, 25, 20))
        assertEquals(0, policy.targetStrength(CoyoteChannel.B, 3, -10))
    }

    @Test
    fun `protocol runtime emits bounded output and ignores stale strength after stop`() {
        val runtime = CoyoteProtocolRuntime()
        val policy = CoyoteSafetyPolicy(maxStrengthA = 30, maxStrengthB = 40)
        runtime.reset(CoyoteGeneration.V3)

        assertEquals("applied", runtime.start(CoyoteChannel.A, 5, "pulse_mid", true, policy).reason)
        val packet = runtime.nextV3Packet(policy)
        assertEquals(5, packet[2].toInt())
        assertEquals(10, packet[4].toInt())
        assertEquals(60, packet[8].toInt())

        runtime.stop(CoyoteChannel.A)
        assertEquals(0, runtime.snapshot().strengthA)
        assertFalse(runtime.handleV3Notification(byteArrayOf(0xb1.toByte(), 1, 5, 0)))
        assertEquals(0, runtime.snapshot().strengthA)
    }
}
