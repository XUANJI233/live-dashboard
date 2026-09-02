package com.monika.dashboard.integration

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.monika.dashboard.coyote.CoyoteBleController
import com.monika.dashboard.coyote.CoyoteRemoteControl
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

object CoyoteRemoteCommandStore {
    private const val RETENTION_MS = 14L * 24 * 60 * 60 * 1_000
    private val mutex = Mutex()

    suspend fun executeOnce(
        context: Context,
        requestId: String,
        command: JSONObject,
    ): JSONObject = mutex.withLock {
        val commandText = command.toString()
        val ledger = CoyoteCommandLedger(context.applicationContext)
        try {
            when (val existing = ledger.begin(requestId, commandText)) {
                is BeginResult.Completed -> return@withLock existing.result
                BeginResult.Conflict -> return@withLock terminalResult("conflict", "coyote_request_id_conflict")
                BeginResult.OutcomeUnknown -> return@withLock terminalResult("unknown", "coyote_request_outcome_unknown")
                BeginResult.Execute -> Unit
            }

            val result = CoyoteRemoteControl.execute(command)
            ledger.complete(requestId, commandText, result)
            result
        } finally {
            ledger.close()
        }
    }

    private fun terminalResult(status: String, reason: String): JSONObject = JSONObject().apply {
        put("ok", false)
        put("status", status)
        put("reason", reason)
        put("coyote", CoyoteBleController.state.value.toJson())
    }

    private sealed interface BeginResult {
        data object Execute : BeginResult
        data object Conflict : BeginResult
        data object OutcomeUnknown : BeginResult
        data class Completed(val result: JSONObject) : BeginResult
    }

    private class CoyoteCommandLedger(context: Context) : SQLiteOpenHelper(
        context,
        DATABASE_NAME,
        null,
        DATABASE_VERSION,
    ) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                """
                CREATE TABLE coyote_remote_commands (
                    request_id TEXT PRIMARY KEY,
                    command TEXT NOT NULL,
                    state TEXT NOT NULL,
                    result TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

        fun begin(requestId: String, command: String): BeginResult {
            val now = System.currentTimeMillis()
            val db = writableDatabase
            db.beginTransaction()
            return try {
                db.delete(TABLE, "created_at < ?", arrayOf((now - RETENTION_MS).toString()))
                val existing = db.query(
                    TABLE,
                    arrayOf("command", "state", "result"),
                    "request_id = ?",
                    arrayOf(requestId),
                    null,
                    null,
                    null,
                    "1",
                ).use { cursor ->
                    if (!cursor.moveToFirst()) {
                        null
                    } else {
                        ExistingCommand(
                            command = cursor.getString(0),
                            state = cursor.getString(1),
                            result = cursor.getString(2),
                        )
                    }
                }
                val decision = when {
                    existing == null -> {
                        db.insertOrThrow(
                            TABLE,
                            null,
                            ContentValues().apply {
                                put("request_id", requestId)
                                put("command", command)
                                put("state", STATE_EXECUTING)
                                put("result", "")
                                put("created_at", now)
                                put("updated_at", now)
                            },
                        )
                        BeginResult.Execute
                    }
                    existing.command != command -> BeginResult.Conflict
                    existing.state != STATE_COMPLETED -> BeginResult.OutcomeUnknown
                    else -> runCatching { JSONObject(existing.result) }
                        .fold(BeginResult::Completed) { BeginResult.OutcomeUnknown }
                }
                db.setTransactionSuccessful()
                decision
            } finally {
                db.endTransaction()
            }
        }

        fun complete(requestId: String, command: String, result: JSONObject) {
            val changed = writableDatabase.update(
                TABLE,
                ContentValues().apply {
                    put("state", STATE_COMPLETED)
                    put("result", result.toString())
                    put("updated_at", System.currentTimeMillis())
                },
                "request_id = ? AND command = ? AND state = ?",
                arrayOf(requestId, command, STATE_EXECUTING),
            )
            check(changed == 1) { "coyote_command_ledger_update_failed" }
        }

        companion object {
            private const val DATABASE_NAME = "coyote_remote_commands.db"
            private const val DATABASE_VERSION = 1
            private const val TABLE = "coyote_remote_commands"
            private const val STATE_EXECUTING = "executing"
            private const val STATE_COMPLETED = "completed"
        }
    }

    private data class ExistingCommand(
        val command: String,
        val state: String,
        val result: String,
    )
}
