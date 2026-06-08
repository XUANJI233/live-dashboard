package com.monika.dashboard.service

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.PendingReportStore
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.data.UploadItem
import com.monika.dashboard.data.UploadStatusStore
import com.monika.dashboard.network.ReportClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

class PendingReportWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val settings = SettingsStore(applicationContext)
        val url = settings.serverUrl.first()
        val token = settings.getToken()
        if (url.isBlank() || token.isNullOrBlank()) return@withContext Result.success()

        val client = runCatching { ReportClient(url, token, applicationContext) }.getOrElse {
            return@withContext Result.retry()
        }
        try {
            val ok = flush(applicationContext, client)
            if (ok) Result.success() else Result.retry()
        } finally {
            client.shutdown()
        }
    }

    companion object {
        private const val WORK_NAME = "pending_report_flush"

        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<PendingReportWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL, 30L, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, request)
        }

        fun flush(context: Context, client: ReportClient, limit: Int = 8): Boolean {
            val items = PendingReportStore.peek(context, limit)
            if (items.isEmpty()) return true
            for (item in items) {
                val result = client.postReportBody(item.body)
                if (result.isSuccess) {
                    PendingReportStore.remove(context, item.id)
                    UploadStatusStore.mark(context, UploadItem.FOREGROUND, true, "已补传队列")
                } else {
                    val message = result.exceptionOrNull()?.message ?: "pending upload failed"
                    PendingReportStore.markAttempt(context, item.id, message)
                    UploadStatusStore.mark(context, UploadItem.FOREGROUND, false, "补传失败: $message")
                    DebugLog.log("上报队列", "补传失败: $message")
                    return false
                }
            }
            val remaining = PendingReportStore.count(context)
            DebugLog.log("上报队列", if (remaining == 0) "补传完成" else "已补传 ${items.size} 条，剩余 $remaining")
            return remaining == 0
        }
    }
}
