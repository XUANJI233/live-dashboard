package com.monika.dashboard.system

import android.accessibilityservice.AccessibilityService
import android.content.pm.PackageManager
import android.view.accessibility.AccessibilityEvent
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.realtime.SupervisionAlertController

class AppAccessibilityService : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val safeEvent = event ?: return
        if (safeEvent.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            safeEvent.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
            return
        }
        val packageName = safeEvent.packageName?.toString()?.takeIf { it.isNotBlank() }
        val className = safeEvent.className?.toString()?.takeIf { it.isNotBlank() }
        val title = safeEvent.text?.joinToString(" ")?.take(256)?.takeIf { it.isNotBlank() }
        if (packageName == null && title == null) return

        val foreground = ForegroundInfo(
            packageName = packageName,
            appName = packageName?.let(::resolveAppName) ?: packageName,
            activity = title ?: className,
            title = title,
            source = "accessibility",
            confidence = 0.65,
        )
        SystemSnapshotStore.updateFromAccessibility(foreground)
        SupervisionAlertController.onSnapshot(applicationContext, SystemSnapshot(foreground = foreground))
    }

    override fun onInterrupt() {
        DebugLog.log("辅助功能", "服务被中断")
    }

    private fun resolveAppName(packageName: String): String? {
        return try {
            val info = packageManager.getApplicationInfo(packageName, 0)
            packageManager.getApplicationLabel(info).toString()
        } catch (_: PackageManager.NameNotFoundException) {
            null
        } catch (_: Exception) {
            null
        }
    }
}
