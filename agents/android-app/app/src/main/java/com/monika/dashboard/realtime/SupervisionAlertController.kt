package com.monika.dashboard.realtime

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.system.SystemSnapshot
import org.json.JSONObject

object SupervisionAlertController {
    private const val TYPE = "supervision_alert"
    private const val DEFAULT_ACTIVE_MS = 45 * 60_000L
    private const val DEFAULT_RESTART_COOLDOWN_MS = 120_000L
    private const val NON_RECOVERY_GRACE_MS = 30_000L
    private const val MAX_REGEX_COUNT = 12

    private val handler = Handler(Looper.getMainLooper())
    private var active: ActiveAlert? = null

    fun handleIncoming(
        context: Context,
        messageId: String,
        payloadText: String?,
    ) {
        val payload = runCatching { JSONObject(payloadText.orEmpty()) }.getOrNull() ?: return
        if (payload.optString("type") != TYPE) return

        val alert = ActiveAlert(
            id = payload.optString("alert_id").ifBlank { messageId },
            recovery = compileRegexList(payload.optJSONArray("recovery_regex")),
            violation = compileRegexList(payload.optJSONArray("violation_regex")),
            activeUntil = parseTime(payload.optString("active_until"))
                ?: (System.currentTimeMillis() + DEFAULT_ACTIVE_MS),
            restartCooldownMs = payload.optLong("restart_cooldown_seconds", DEFAULT_RESTART_COOLDOWN_MS / 1000)
                .coerceIn(30, 600) * 1000,
            vibrate = payload.optBoolean("vibrate", true),
        )
        active = alert
        DebugLog.log("监督", "收到监督提醒: ${alert.id}")
        if (alert.vibrate) startVibration(context, alert)
        scheduleExpiry(context, alert)
    }

    fun onSnapshot(context: Context, snapshot: SystemSnapshot) {
        val alert = active ?: return
        val now = System.currentTimeMillis()
        if (now >= alert.activeUntil) {
            clear(context, alert)
            return
        }

        val text = snapshot.matchText()
        val recovered = alert.recovery.isNotEmpty() && alert.recovery.any { it.containsMatchIn(text) }
        if (recovered) {
            if (alert.vibrating) stopVibration(context, alert, keepActive = true)
            alert.recoveredAt = now
            return
        }

        if (!alert.vibrate || alert.vibrating) return
        val violated = alert.violation.isNotEmpty() && alert.violation.any { it.containsMatchIn(text) }
        val leftRecoveryLongEnough = alert.recovery.isNotEmpty() &&
            alert.recoveredAt > 0 &&
            now - alert.recoveredAt >= NON_RECOVERY_GRACE_MS
        val cooldownOk = now - alert.lastVibrateAt >= alert.restartCooldownMs
        if ((violated || leftRecoveryLongEnough) && cooldownOk) {
            DebugLog.log("监督", "检测到再次偏离，恢复震动")
            startVibration(context, alert)
        }
    }

    private fun compileRegexList(arr: org.json.JSONArray?): List<Regex> {
        if (arr == null) return emptyList()
        val out = mutableListOf<Regex>()
        for (index in 0 until arr.length()) {
            val pattern = arr.optString(index).trim().take(120)
            if (!isSafePattern(pattern)) continue
            runCatching { Regex(pattern, RegexOption.IGNORE_CASE) }
                .onSuccess { out += it }
            if (out.size >= MAX_REGEX_COUNT) break
        }
        return out
    }

    private fun isSafePattern(pattern: String): Boolean {
        if (pattern.isBlank() || pattern.length > 120) return false
        val compact = pattern.replace(Regex("""\s+"""), "")
        if (isCatchAllPattern(compact)) return false
        if (Regex("""\\[1-9]""").containsMatchIn(pattern)) return false
        if (Regex("""\(\?<[!=]""").containsMatchIn(pattern)) return false
        if (Regex("""\([^)]*[+*][^)]*\)[+*{]""").containsMatchIn(pattern)) return false
        if (Regex("""(?:\.\*){3,}""").containsMatchIn(pattern)) return false
        if (Regex("""\{\d{3,}(?:,|\})""").containsMatchIn(pattern)) return false
        return true
    }

    private fun isCatchAllPattern(compact: String): Boolean =
        setOf(".*", ".+", """[\s\S]*""", """[\S\s]*""").contains(compact)

    private fun parseTime(value: String): Long? =
        runCatching { java.time.Instant.parse(value).toEpochMilli() }.getOrNull()

    @SuppressLint("MissingPermission")
    private fun startVibration(context: Context, alert: ActiveAlert) {
        val vibrator = vibrator(context) ?: return
        if (!vibrator.hasVibrator()) return
        alert.vibrating = true
        alert.lastVibrateAt = System.currentTimeMillis()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 450, 350, 450, 1200), 1))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(longArrayOf(0, 450, 350, 450, 1200), 1)
        }
    }

    private fun stopVibration(context: Context, alert: ActiveAlert, keepActive: Boolean) {
        vibrator(context)?.cancel()
        alert.vibrating = false
        if (!keepActive) active = null
        DebugLog.log("监督", if (keepActive) "已切回目标，停止震动并继续监督" else "监督提醒结束")
    }

    private fun clear(context: Context, alert: ActiveAlert) {
        stopVibration(context, alert, keepActive = false)
    }

    private fun scheduleExpiry(context: Context, alert: ActiveAlert) {
        val delayMs = (alert.activeUntil - System.currentTimeMillis()).coerceAtLeast(1_000L)
        handler.postDelayed({
            if (active?.id == alert.id && System.currentTimeMillis() >= alert.activeUntil) {
                clear(context.applicationContext, alert)
            }
        }, delayMs)
    }

    private fun vibrator(context: Context): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = context.getSystemService(VibratorManager::class.java)
            manager?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

    private fun SystemSnapshot.matchText(): String = listOfNotNull(
        foreground?.packageName,
        foreground?.appName,
        foreground?.activity,
        foreground?.title,
        media?.packageName,
        media?.app,
        media?.title,
        media?.artist,
        media?.state,
    ).joinToString(" ")

    private data class ActiveAlert(
        val id: String,
        val recovery: List<Regex>,
        val violation: List<Regex>,
        val activeUntil: Long,
        val restartCooldownMs: Long,
        val vibrate: Boolean,
        var vibrating: Boolean = false,
        var recoveredAt: Long = 0L,
        var lastVibrateAt: Long = 0L,
    )
}
