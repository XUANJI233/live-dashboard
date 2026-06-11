package com.monika.dashboard.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.monika.dashboard.realtime.MessageSocketManager
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MessageInboxStoreTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        // Clear state between tests
        MessageInboxStore.clearForTest(context)
    }

    @After
    fun tearDown() {
        MessageInboxStore.clearForTest(context)
    }

    // ── JSON Parse ──

    @Test
    fun `parse valid JSON returns messages`() {
        val raw = """
            [
                {"id":"m1","viewer_id":"v1","viewer_name":"Alice","viewer_remark":"","kind":"private","direction":"viewer","text":"hello","at":1000},
                {"id":"m2","viewer_id":"v2","viewer_name":"Bob","viewer_remark":"ok","kind":"public","direction":"admin","text":"hi","at":2000}
            ]
        """.trimIndent()
        val prefs = context.getSharedPreferences("visitor_messages", Context.MODE_PRIVATE)
        prefs.edit().putString("recent", raw).commit()

        val result = MessageInboxStore.recentFromDisk(context)

        assertEquals(2, result.size)
        assertEquals("m1", result[0].id)
        assertEquals("v1", result[0].viewerId)
        assertEquals("Alice", result[0].viewerName)
        assertEquals("private", result[0].kind)
        assertEquals("viewer", result[0].direction)
        assertEquals("hello", result[0].text)
        assertEquals(1000L, result[0].at)

        assertEquals("m2", result[1].id)
        assertEquals("Bob", result[1].viewerName)
        assertEquals("ok", result[1].viewerRemark)
        assertEquals("public", result[1].kind)
    }

    @Test
    fun `parse invalid JSON returns empty list`() {
        val prefs = context.getSharedPreferences("visitor_messages", Context.MODE_PRIVATE)
        prefs.edit().putString("recent", "not json").commit()

        val result = MessageInboxStore.recentFromDisk(context)
        assertTrue(result.isEmpty())
    }

    @Test
    fun `parse empty JSON array returns empty list`() {
        val prefs = context.getSharedPreferences("visitor_messages", Context.MODE_PRIVATE)
        prefs.edit().putString("recent", "[]").commit()

        val result = MessageInboxStore.recentFromDisk(context)
        assertTrue(result.isEmpty())
    }

    @Test
    fun `parse missing key returns empty list`() {
        val prefs = context.getSharedPreferences("visitor_messages", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()

        val result = MessageInboxStore.recentFromDisk(context)
        assertTrue(result.isEmpty())
    }

    @Test
    fun `supervisor viewer id is privileged`() {
        assertTrue(MessageInboxStore.isPrivilegedViewer(MessageInboxStore.SUPERVISOR_VIEWER_ID))
        MessageSocketManager.blockViewer(context, MessageInboxStore.SUPERVISOR_VIEWER_ID)

        assertFalse(MessageSocketManager.isViewerBlocked(context, MessageInboxStore.SUPERVISOR_VIEWER_ID))
        assertFalse(MessageSocketManager.blockedViewers(context).contains(MessageInboxStore.SUPERVISOR_VIEWER_ID))
    }

    @Test
    fun `parse skips malformed items`() {
        val raw = """
            [
                {"id":"ok","viewer_id":"v1","text":"good","at":100},
                "not_an_object",
                {"id":"also_ok","viewer_id":"v2","text":"fine","at":200}
            ]
        """.trimIndent()
        val prefs = context.getSharedPreferences("visitor_messages", Context.MODE_PRIVATE)
        prefs.edit().putString("recent", raw).commit()

        val result = MessageInboxStore.recentFromDisk(context)
        assertEquals(2, result.size)
        assertEquals("ok", result[0].id)
        assertEquals("also_ok", result[1].id)
    }

    // ── Add ──

    @Test
    fun `add inserts message and deduplicates by id`() {
        MessageInboxStore.add(context, "m1", "v1", "hello", viewerName = "Alice", at = 1000)
        MessageInboxStore.add(context, "m1", "v1", "updated", viewerName = "Alice", at = 2000)

        val result = MessageInboxStore.recentFromDisk(context)
        assertEquals(1, result.size)
        assertEquals("updated", result[0].text)
        assertEquals(2000L, result[0].at)
    }

    @Test
    fun `add generates id when blank`() {
        MessageInboxStore.add(context, "", "v1", "hello", at = 1000)

        val result = MessageInboxStore.recentFromDisk(context)
        assertEquals(1, result.size)
        assertTrue(result[0].id.startsWith("v1_"))
    }

    @Test
    fun `add ignores blank viewerId or text`() {
        MessageInboxStore.add(context, "m1", "", "hello")
        MessageInboxStore.add(context, "m2", "v1", "")

        val result = MessageInboxStore.recentFromDisk(context)
        assertTrue(result.isEmpty())
    }

    @Test
    fun `add trims text to 500 chars`() {
        val longText = "x".repeat(600)
        MessageInboxStore.add(context, "m1", "v1", longText, at = 1000)

        val result = MessageInboxStore.recentFromDisk(context)
        assertEquals(1, result.size)
        assertEquals(500, result[0].text.length)
    }

    // ── UpsertAll ──

    @Test
    fun `upsertAll merges with dedup by id`() {
        MessageInboxStore.add(context, "m1", "v1", "old", at = 1000)
        MessageInboxStore.add(context, "m2", "v2", "keep", at = 2000)

        val incoming = listOf(
            VisitorMessage("m1", "v1", "Alice", "", "private", "viewer", "new", 3000),
            VisitorMessage("m3", "v3", "Charlie", "", "private", "viewer", "fresh", 4000),
        )
        MessageInboxStore.upsertAll(context, incoming)

        val result = MessageInboxStore.recentFromDisk(context)
        assertEquals(3, result.size)
        // m3 should be first (at=4000), then m1 (at=3000 replaced), then m2 (at=2000 kept)
        assertEquals("m3", result[0].id)
        assertEquals("fresh", result[0].text)
        assertEquals("m1", result[1].id)
        assertEquals("new", result[1].text) // overwritten by upsert
        assertEquals("m2", result[2].id)
        assertEquals("keep", result[2].text)
    }

    @Test
    fun `upsertAll sorts by at descending`() {
        val incoming = listOf(
            VisitorMessage("m1", "v1", "A", "", "private", "viewer", "first", 1000),
            VisitorMessage("m2", "v2", "B", "", "private", "viewer", "third", 3000),
            VisitorMessage("m3", "v3", "C", "", "private", "viewer", "second", 2000),
        )
        MessageInboxStore.upsertAll(context, incoming)

        val result = MessageInboxStore.recentFromDisk(context)
        assertEquals(3, result.size)
        assertTrue(result[0].at >= result[1].at)
        assertTrue(result[1].at >= result[2].at)
    }

    // ── Delete ──

    @Test
    fun `delete removes by messageId`() {
        MessageInboxStore.add(context, "m1", "v1", "hello", at = 1000)
        MessageInboxStore.add(context, "m2", "v2", "world", at = 2000)

        MessageInboxStore.delete(context, "m1")

        val result = MessageInboxStore.recentFromDisk(context)
        assertEquals(1, result.size)
        assertEquals("m2", result[0].id)
    }

    @Test
    fun `delete ignores blank id`() {
        MessageInboxStore.add(context, "m1", "v1", "hello", at = 1000)
        MessageInboxStore.delete(context, "")

        assertEquals(1, MessageInboxStore.recentFromDisk(context).size)
    }

    // ── DeleteViewer ──

    @Test
    fun `deleteViewer removes all messages from viewer`() {
        MessageInboxStore.add(context, "m1", "v1", "msg1", at = 1000)
        MessageInboxStore.add(context, "m2", "v2", "msg2", at = 2000)
        MessageInboxStore.add(context, "m3", "v1", "msg3", at = 3000)

        MessageInboxStore.deleteViewer(context, "v1")

        val result = MessageInboxStore.recentFromDisk(context)
        assertEquals(1, result.size)
        assertEquals("v2", result[0].viewerId)
    }

    // ── SetRemark ──

    @Test
    fun `setRemark updates all messages from viewer`() {
        MessageInboxStore.add(context, "m1", "v1", "msg1", at = 1000)
        MessageInboxStore.add(context, "m2", "v2", "msg2", at = 2000)
        MessageInboxStore.add(context, "m3", "v1", "msg3", at = 3000)

        MessageInboxStore.setRemark(context, "v1", "noted")

        val result = MessageInboxStore.recentFromDisk(context)
        val v1Messages = result.filter { it.viewerId == "v1" }
        assertEquals(2, v1Messages.size)
        v1Messages.forEach { assertEquals("noted", it.viewerRemark) }
        assertEquals("", result.first { it.viewerId == "v2" }.viewerRemark) // unchanged
    }

    @Test
    fun `setRemark trims to 500 chars`() {
        MessageInboxStore.add(context, "m1", "v1", "msg", at = 1000)
        val longRemark = "x".repeat(600)
        MessageInboxStore.setRemark(context, "v1", longRemark)

        val result = MessageInboxStore.recentFromDisk(context)
        assertEquals(500, result[0].viewerRemark.length)
    }

    // ── Max Messages Cap ──

    @Test
    fun `exceeding max messages trims to 500`() {
        for (i in 1..600) {
            MessageInboxStore.add(context, "m$i", "v$i", "msg$i", at = i.toLong())
        }

        val result = MessageInboxStore.recentFromDisk(context)
        assertTrue(result.size <= 500)
        // Most recent should be kept (highest at)
        assertEquals("m600", result[0].id)
        assertEquals(600L, result[0].at)
    }
}
