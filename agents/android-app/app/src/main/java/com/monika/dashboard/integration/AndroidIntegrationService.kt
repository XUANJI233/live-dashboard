package com.monika.dashboard.integration

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationCompat
import com.monika.dashboard.MainActivity
import com.monika.dashboard.R
import com.monika.dashboard.coyote.CoyoteBleController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class AndroidIntegrationService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, notification(getString(R.string.integration_service_starting)))
        mutableRunning.value = true
        CoyoteBleController.initialize(applicationContext)
        AndroidIntegrationSocket.start(applicationContext)
        scope.launch {
            CoyoteBleController.state.collect { state ->
                val detail = when {
                    state.connected -> getString(R.string.integration_notification_coyote_connected, state.deviceName)
                    state.connecting -> getString(R.string.integration_notification_coyote_connecting)
                    else -> getString(R.string.integration_notification_online)
                }
                getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, notification(detail))
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONNECT -> intent.getStringExtra(EXTRA_ADDRESS)?.let(CoyoteBleController::connect)
            ACTION_EMERGENCY_STOP -> CoyoteBleController.emergencyStop()
            ACTION_DISCONNECT -> CoyoteBleController.disconnect()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        CoyoteBleController.emergencyStop()
        CoyoteBleController.disconnect()
        AndroidIntegrationSocket.stop()
        mutableRunning.value = false
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun notification(detail: String) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle(getString(R.string.integration_notification_title))
        .setContentText(detail)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        .addAction(
            0,
            getString(R.string.integration_notification_emergency_stop),
            servicePendingIntent(ACTION_EMERGENCY_STOP, 1),
        )
        .addAction(
            0,
            getString(R.string.integration_notification_disconnect),
            servicePendingIntent(ACTION_DISCONNECT, 2),
        )
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .build()

    private fun servicePendingIntent(action: String, requestCode: Int): PendingIntent =
        PendingIntent.getService(
            this,
            requestCode,
            Intent(this, AndroidIntegrationService::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.integration_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.integration_notification_channel_description)
        }
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    companion object {
        private const val CHANNEL_ID = "android_integrations"
        private const val NOTIFICATION_ID = 2401
        private const val ACTION_CONNECT = "com.monika.dashboard.integration.CONNECT_COYOTE"
        private const val ACTION_EMERGENCY_STOP = "com.monika.dashboard.integration.EMERGENCY_STOP_COYOTE"
        private const val ACTION_DISCONNECT = "com.monika.dashboard.integration.DISCONNECT_COYOTE"
        private const val EXTRA_ADDRESS = "address"
        private val mutableRunning = MutableStateFlow(false)
        val running = mutableRunning.asStateFlow()

        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, AndroidIntegrationService::class.java),
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AndroidIntegrationService::class.java))
        }

        fun connect(context: Context, address: String) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, AndroidIntegrationService::class.java)
                    .setAction(ACTION_CONNECT)
                    .putExtra(EXTRA_ADDRESS, address),
            )
        }
    }
}
