package com.monika.dashboard.integration

import java.net.Proxy
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

class AutoAccountingClient(
    private val client: OkHttpClient = sharedClient,
) {
    fun fetchCompletedBills(start: Instant, end: Instant): Result<List<ProcessedAccountingBill>> {
        require(end.isAfter(start)) { "AutoAccounting 时间范围无效" }
        val startMs = start.toEpochMilli()
        val endMs = end.toEpochMilli()
        val url = "$BASE_URL/bill/range?start=${encode(startMs)}&end=${encode(endMs)}"
        val request = Request.Builder().url(url).get().build()
        return runCatching {
            client.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                require(response.isSuccessful) { "AutoAccounting HTTP ${response.code}" }
                AutoAccountingParser.parseCompletedBills(body)
            }
        }
    }

    fun healthCheck(): Boolean {
        val request = Request.Builder().url(BASE_URL).get().build()
        return runCatching {
            client.newCall(request).execute().use { response -> response.isSuccessful }
        }.getOrDefault(false)
    }

    private fun encode(value: Long): String = URLEncoder.encode(value.toString(), StandardCharsets.UTF_8.name())

    companion object {
        const val BASE_URL = "http://127.0.0.1:52045"

        private val sharedClient = OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY)
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            .build()
    }
}
