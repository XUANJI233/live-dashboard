package com.monika.dashboard.integration

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.monika.dashboard.coyote.CoyoteBleController
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class CoyoteRemoteCommandStoreTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun `remote consent is cleared when the Coyote session disconnects`() {
        CoyoteBleController.initialize(context)
        CoyoteBleController.setRemoteControlEnabled(true)
        assertTrue(CoyoteBleController.state.value.remoteControlEnabled)

        CoyoteBleController.disconnect()

        assertFalse(CoyoteBleController.state.value.remoteControlEnabled)
    }

    @Test
    fun `stable request id replays one stored result and rejects a different command`() = runTest {
        CoyoteBleController.initialize(context)
        val requestId = "coyote_${UUID.randomUUID()}"
        val command = JSONObject().put("action", "start").put("channel", "A").put("strength", 5)

        val first = CoyoteRemoteCommandStore.executeOnce(context, requestId, command)
        val replay = CoyoteRemoteCommandStore.executeOnce(context, requestId, command)
        val conflict = CoyoteRemoteCommandStore.executeOnce(
            context,
            requestId,
            JSONObject().put("action", "adjust").put("channel", "A").put("delta", 5),
        )

        assertEquals(first.toString(), replay.toString())
        assertEquals("conflict", conflict.optString("status"))
        assertEquals("coyote_request_id_conflict", conflict.optString("reason"))
    }
}
