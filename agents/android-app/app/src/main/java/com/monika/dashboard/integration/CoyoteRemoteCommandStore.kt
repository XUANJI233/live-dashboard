package com.monika.dashboard.integration

import android.content.Context
import com.monika.dashboard.coyote.CoyoteBleController
import com.monika.dashboard.coyote.CoyoteRemoteControl
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

object CoyoteRemoteCommandStore {
    private const val PREFERENCES = "coyote_remote_commands"
    private const val KEY_RESULTS = "results"
    private const val MAX_RESULTS = 100
    private val mutex = Mutex()

    suspend fun executeOnce(
        context: Context,
        requestId: String,
        command: JSONObject,
    ): JSONObject = mutex.withLock {
        val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val stored = JSONObject(preferences.getString(KEY_RESULTS, "{}").orEmpty().ifBlank { "{}" })
        val existing = stored.optJSONObject(requestId)
        val commandText = command.toString()
        if (existing != null) {
            if (existing.optString("command") != commandText) {
                return@withLock JSONObject().apply {
                    put("ok", false)
                    put("status", "conflict")
                    put("reason", "coyote_request_id_conflict")
                    put("coyote", CoyoteBleController.state.value.toJson())
                }
            }
            return@withLock existing.optJSONObject("result") ?: JSONObject()
        }

        val result = CoyoteRemoteControl.execute(command)
        stored.put(
            requestId,
            JSONObject().apply {
                put("command", commandText)
                put("result", result)
            },
        )
        val keys = buildList {
            val iterator = stored.keys()
            while (iterator.hasNext()) add(iterator.next())
        }
        for (key in keys.dropLast(MAX_RESULTS)) stored.remove(key)
        preferences.edit().putString(KEY_RESULTS, stored.toString()).apply()
        result
    }
}
