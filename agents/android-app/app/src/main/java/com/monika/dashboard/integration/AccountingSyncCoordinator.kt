package com.monika.dashboard.integration

import android.content.Context
import com.monika.dashboard.data.SettingsStore
import java.io.IOException
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
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
    val completedAt: String,
    val error: String = "",
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("available", available)
        put("fetched", fetched)
        put("accepted", accepted)
        put("skipped", skipped)
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

    suspend fun sync(start: Instant, end: Instant): AccountingSyncResult = withContext(Dispatchers.IO) {
        val completedAt = Instant.now().toString()
        val source = sourceClient.fetchCompletedBills(start, end)
        if (source.isFailure) {
            val message = source.exceptionOrNull()?.message.orEmpty().ifBlank { "AutoAccounting 不可用" }.take(240)
            preferences.accountingLastError = message
            return@withContext AccountingSyncResult(false, 0, 0, 0, completedAt, message)
        }
        val bills = source.getOrThrow()
        val serverUrl = settings.serverUrl.first().trimEnd('/')
        val token = settings.getToken().orEmpty()
        if (serverUrl.isBlank() || token.isBlank()) {
            val message = "请先配置 Live Dashboard 服务器和 Token"
            preferences.accountingLastError = message
            return@withContext AccountingSyncResult(true, bills.size, 0, bills.size, completedAt, message)
        }

        var accepted = 0
        var skipped = 0
        val uploaded = runCatching {
            for (batch in bills.chunked(UPLOAD_BATCH_SIZE).ifEmpty { listOf(emptyList()) }) {
                val result = uploadBatch(serverUrl, token, batch)
                accepted += result.first
                skipped += result.second
            }
        }
        uploaded.exceptionOrNull()?.let { error ->
            val message = error.message.orEmpty().ifBlank { "账单上传失败" }.take(240)
            preferences.accountingLastError = message
            return@withContext AccountingSyncResult(true, bills.size, accepted, skipped, completedAt, message)
        }

        preferences.accountingLastSyncAt = completedAt
        preferences.accountingLastError = ""
        AccountingSyncResult(true, bills.size, accepted, skipped, completedAt)
    }

    suspend fun syncRecent(days: Long = 365): AccountingSyncResult {
        val end = Instant.now().plus(1, ChronoUnit.MINUTES)
        return sync(end.minus(days.coerceIn(1, 3650), ChronoUnit.DAYS), end)
    }

    private fun uploadBatch(
        serverUrl: String,
        token: String,
        bills: List<ProcessedAccountingBill>,
    ): Pair<Int, Int> {
        val body = JSONObject().apply {
            put("source", "autoaccounting")
            put("bills", JSONArray().apply { bills.forEach { put(it.toJson()) } })
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
            return json.optInt("accepted", 0) to json.optInt("skipped", 0)
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
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
