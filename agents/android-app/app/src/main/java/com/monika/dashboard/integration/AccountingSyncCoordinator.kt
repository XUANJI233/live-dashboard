package com.monika.dashboard.integration

import android.content.Context
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.R
import java.io.IOException
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

data class AccountingSyncResult(
    val available: Boolean,
    val fetched: Int,
    val accepted: Int,
    val skipped: Int,
    val pruned: Int,
    val completedAt: String,
    val error: String = "",
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("available", available)
        put("fetched", fetched)
        put("accepted", accepted)
        put("skipped", skipped)
        put("pruned", pruned)
        put("last_sync_at", completedAt)
        put("last_error", error)
    }
}

class AccountingSyncCoordinator(
    context: Context,
    private val sourceClient: AutoAccountingClient = AutoAccountingClient(),
    private val uploadClient: OkHttpClient = sharedUploadClient,
) {
    private val appContext = context.applicationContext
    private val settings = SettingsStore(appContext)
    private val preferences = AndroidIntegrationPreferences(appContext)

    suspend fun sync(start: Instant, end: Instant): AccountingSyncResult = syncMutex.withLock {
        withContext(Dispatchers.IO) {
        val completedAt = Instant.now().toString()
        val source = sourceClient.fetchCompletedBills(start, end)
        if (source.isFailure) {
            val detail = source.exceptionOrNull()?.message.orEmpty().ifBlank { "unavailable" }.take(180)
            val message = appContext.getString(R.string.accounting_error_unavailable, detail).take(240)
            preferences.accountingLastError = message
            return@withContext AccountingSyncResult(false, 0, 0, 0, 0, completedAt, message)
        }
        val bills = source.getOrThrow()
        val serverUrl = settings.serverUrl.first().trimEnd('/')
        val token = settings.getToken().orEmpty()
        if (serverUrl.isBlank() || token.isBlank()) {
            val message = appContext.getString(R.string.accounting_error_server_config)
            preferences.accountingLastError = message
            return@withContext AccountingSyncResult(true, bills.size, 0, bills.size, 0, completedAt, message)
        }

        var accepted = 0
        var skipped = 0
        var pruned = 0
        val syncId = "accounting_${java.util.UUID.randomUUID()}"
        val batches = bills.chunked(UPLOAD_BATCH_SIZE).ifEmpty { listOf(emptyList()) }
        val uploaded = runCatching {
            val plans = batches.mapIndexed { batchIndex, batch ->
                AccountingUploadBatch(syncId, start, end, batchIndex, batches.size, batch)
            }
            val results = coroutineScope {
                val preliminary = plans.dropLast(1).map { plan ->
                    async { uploadBatch(serverUrl, token, plan) }
                }.awaitAll()
                preliminary + uploadBatch(serverUrl, token, plans.last())
            }
            for (result in results) {
                accepted += result.accepted
                skipped += result.skipped
                pruned += result.pruned
            }
        }
        uploaded.exceptionOrNull()?.let { error ->
            val detail = error.message.orEmpty().ifBlank { "request failed" }.take(180)
            val message = appContext.getString(R.string.accounting_error_upload, detail).take(240)
            preferences.accountingLastError = message
            return@withContext AccountingSyncResult(true, bills.size, accepted, skipped, pruned, completedAt, message)
        }

        preferences.accountingLastSyncAt = completedAt
        preferences.accountingLastError = ""
        AccountingSyncResult(true, bills.size, accepted, skipped, pruned, completedAt)
        }
    }

    suspend fun syncRecent(days: Long = 365): AccountingSyncResult {
        val end = Instant.now().plus(1, ChronoUnit.MINUTES)
        return sync(end.minus(days.coerceIn(1, 3650), ChronoUnit.DAYS), end)
    }

    private fun uploadBatch(
        serverUrl: String,
        token: String,
        batch: AccountingUploadBatch,
    ): UploadResult {
        val body = JSONObject().apply {
            put("source", "autoaccounting")
            put("sync_id", batch.syncId)
            put("range_start", batch.rangeStart.toString())
            put("range_end", batch.rangeEnd.toString())
            put("batch_index", batch.batchIndex)
            put("batch_count", batch.batchCount)
            put("bills", JSONArray().apply { batch.bills.forEach { put(it.toJson()) } })
        }.toString().toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder()
            .url("$serverUrl/api/accounting/bills")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        uploadClient.newCall(request).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IOException("Live Dashboard HTTP ${response.code}: ${errorText(raw)}")
            val json = JSONObject(raw)
            return UploadResult(
                accepted = json.optInt("accepted", 0),
                skipped = json.optInt("skipped", 0),
                pruned = json.optInt("pruned", 0),
            )
        }
    }

    private fun errorText(raw: String): String = runCatching {
        JSONObject(raw).optString("error")
    }.getOrDefault("").ifBlank { "request failed" }.take(240)

    companion object {
        private const val UPLOAD_BATCH_SIZE = 250
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val sharedUploadClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .build()
        private val syncMutex = Mutex()
    }

    private data class UploadResult(
        val accepted: Int,
        val skipped: Int,
        val pruned: Int,
    )

    private data class AccountingUploadBatch(
        val syncId: String,
        val rangeStart: Instant,
        val rangeEnd: Instant,
        val batchIndex: Int,
        val batchCount: Int,
        val bills: List<ProcessedAccountingBill>,
    )
}
