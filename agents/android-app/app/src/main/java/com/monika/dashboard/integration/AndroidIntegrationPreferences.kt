package com.monika.dashboard.integration

import android.content.Context
import com.monika.dashboard.coyote.CoyoteSafetyPolicy

class AndroidIntegrationPreferences(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    var coyoteRemoteControlEnabled: Boolean
        get() = preferences.getBoolean(KEY_COYOTE_REMOTE_CONTROL, false)
        set(value) {
            preferences.edit().putBoolean(KEY_COYOTE_REMOTE_CONTROL, value).apply()
        }

    var coyoteLimitA: Int
        get() = preferences.getInt(KEY_COYOTE_LIMIT_A, CoyoteSafetyPolicy.DEFAULT_USER_LIMIT)
            .coerceIn(0, CoyoteSafetyPolicy.MAX_STRENGTH)
        set(value) {
            preferences.edit().putInt(KEY_COYOTE_LIMIT_A, value.coerceIn(0, CoyoteSafetyPolicy.MAX_STRENGTH)).apply()
        }

    var coyoteLimitB: Int
        get() = preferences.getInt(KEY_COYOTE_LIMIT_B, CoyoteSafetyPolicy.DEFAULT_USER_LIMIT)
            .coerceIn(0, CoyoteSafetyPolicy.MAX_STRENGTH)
        set(value) {
            preferences.edit().putInt(KEY_COYOTE_LIMIT_B, value.coerceIn(0, CoyoteSafetyPolicy.MAX_STRENGTH)).apply()
        }

    var accountingLastSyncAt: String
        get() = preferences.getString(KEY_ACCOUNTING_LAST_SYNC_AT, "").orEmpty()
        set(value) {
            preferences.edit().putString(KEY_ACCOUNTING_LAST_SYNC_AT, value.take(40)).apply()
        }

    var accountingLastError: String
        get() = preferences.getString(KEY_ACCOUNTING_LAST_ERROR, "").orEmpty()
        set(value) {
            preferences.edit().putString(KEY_ACCOUNTING_LAST_ERROR, value.take(240)).apply()
        }

    companion object {
        private const val PREFERENCES = "android_integrations"
        private const val KEY_COYOTE_REMOTE_CONTROL = "coyote_remote_control_enabled"
        private const val KEY_COYOTE_LIMIT_A = "coyote_limit_a"
        private const val KEY_COYOTE_LIMIT_B = "coyote_limit_b"
        private const val KEY_ACCOUNTING_LAST_SYNC_AT = "accounting_last_sync_at"
        private const val KEY_ACCOUNTING_LAST_ERROR = "accounting_last_error"
    }
}
