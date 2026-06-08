package com.monika.dashboard.system

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build

object SystemPackageGuard {
    private val protectedExact = setOf(
        "android",
        "system",
        "com.android.systemui",
        "com.android.settings",
        "com.android.permissioncontroller",
        "com.google.android.permissioncontroller",
        "com.android.packageinstaller",
        "com.google.android.packageinstaller",
        "com.android.providers.downloads",
        "com.android.providers.media",
        "com.android.phone",
        "com.google.android.dialer",
        "com.android.contacts",
        "com.android.server.telecom",
        "com.android.bluetooth",
        "com.android.nfc",
        "com.google.android.gms",
        "com.xiaomi.xmsf",
        "com.miui.securitycenter",
        "com.miui.securityadd",
        "com.miui.powerkeeper",
    )

    private val protectedPrefixes = listOf(
        "com.monika.dashboard",
        "com.android.",
        "com.android.inputmethod",
        "com.google.android.inputmethod",
    )

    fun isProtectedForSupervision(context: Context?, packageName: String?): Boolean {
        val clean = packageName?.trim()?.takeIf { it.isNotBlank() } ?: return false
        if (clean in protectedExact) return true
        if (protectedPrefixes.any(clean::startsWith)) return true
        return context != null && isSystemApplication(context, clean)
    }

    private fun isSystemApplication(context: Context, packageName: String): Boolean {
        return try {
            val info = getApplicationInfo(context.packageManager, packageName)
            val systemFlags = ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP
            info.flags and systemFlags != 0
        } catch (_: PackageManager.NameNotFoundException) {
            false
        } catch (_: Exception) {
            false
        }
    }

    @Suppress("DEPRECATION")
    private fun getApplicationInfo(pm: PackageManager, packageName: String): ApplicationInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getApplicationInfo(packageName, PackageManager.ApplicationInfoFlags.of(0))
        } else {
            pm.getApplicationInfo(packageName, 0)
        }
}
