package com.monika.dashboard.network

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.controllerHealthStatus
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ControllerHealthTest {
    @Test
    fun parsesTheServerHealthObject() {
        val health = parseControllerHealth(
            JSONObject(
                """
                {"hermes_enabled":true,"webhook_enabled":true,"paused":false,
                 "last_ack_at":"2026-09-01T10:00:00.000Z","last_failure_at":null,"last_error":"",
                 "last_mcp_at":null,"pending_count":2,"oldest_pending_at":null,"dead_last_24h":1,
                 "unreachable":false}
                """.trimIndent(),
            ),
        )!!
        assertTrue(health.hermesEnabled)
        assertEquals("2026-09-01T10:00:00.000Z", health.lastAckAt)
        assertNull(health.lastFailureAt)
        assertEquals(2, health.pendingCount)
        assertEquals(1, health.deadLast24h)
        assertNull(parseControllerHealth(null))
    }

    @Test
    fun describesPausedUnreachableAndOnlineControllers() {
        val online = ReportClient.ControllerHealth(
            hermesEnabled = true,
            paused = false,
            lastAckAt = "2026-09-01T10:00:00.000Z",
            lastFailureAt = null,
            lastError = "",
            pendingCount = 0,
            deadLast24h = 0,
            unreachable = false,
        )
        assertEquals(DashboardTone.Good, controllerHealthStatus(online).second)
        assertTrue(controllerHealthStatus(online).first.startsWith("监督助手在线"))

        val down = online.copy(unreachable = true, lastError = "http_503", pendingCount = 3)
        val (text, tone) = controllerHealthStatus(down)
        assertEquals(DashboardTone.Warn, tone)
        assertTrue(text.contains("联系不上") && text.contains("http_503") && text.contains("3 条事件待送达"))

        assertTrue(controllerHealthStatus(down.copy(paused = true)).first.startsWith("监督助手已暂停"))
        assertTrue(controllerHealthStatus(online.copy(lastAckAt = null)).first.contains("还没有确认"))
    }
}
