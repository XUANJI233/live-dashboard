package com.monika.dashboard.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PendingReportStoreTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        PendingReportStore.clearForTest(context)
    }

    @After
    fun tearDown() {
        PendingReportStore.clearForTest(context)
    }

    @Test
    fun enqueuePersistsReportsAndKeepsOrder() {
        val first = PendingReportStore.enqueue(context, """{"app_id":"a"}""", "offline")
        val second = PendingReportStore.enqueue(context, """{"app_id":"b"}""")

        val items = PendingReportStore.peek(context)

        assertEquals(first?.id, items[0].id)
        assertEquals(second?.id, items[1].id)
        assertEquals("""{"app_id":"a"}""", items[0].body)
        assertEquals("offline", items[0].lastError)
    }

    @Test
    fun removeAndMarkAttemptUpdateStoredQueue() {
        val first = PendingReportStore.enqueue(context, """{"app_id":"a"}""")!!
        val second = PendingReportStore.enqueue(context, """{"app_id":"b"}""")!!

        PendingReportStore.markAttempt(context, first.id, "HTTP 500")
        PendingReportStore.remove(context, second.id)

        val items = PendingReportStore.peek(context)
        assertEquals(1, items.size)
        assertEquals(first.id, items[0].id)
        assertEquals(1, items[0].attempts)
        assertEquals("HTTP 500", items[0].lastError)
    }

    @Test
    fun queueIsBoundedToNewestFiftyReports() {
        for (i in 0 until 55) {
            PendingReportStore.enqueue(context, """{"app_id":"$i"}""")
        }

        val items = PendingReportStore.peek(context, 60)

        assertEquals(50, items.size)
        assertTrue(items.first().body.contains("5"))
        assertTrue(items.last().body.contains("54"))
    }
}
