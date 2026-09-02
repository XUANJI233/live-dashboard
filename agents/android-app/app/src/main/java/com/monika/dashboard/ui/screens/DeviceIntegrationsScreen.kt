package com.monika.dashboard.ui.screens

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.monika.dashboard.R
import com.monika.dashboard.coyote.CoyoteBleController
import com.monika.dashboard.coyote.CoyoteChannel
import com.monika.dashboard.coyote.CoyoteSafetyPolicy
import com.monika.dashboard.coyote.CoyoteWaveforms
import com.monika.dashboard.integration.AccountingSyncCoordinator
import com.monika.dashboard.integration.AndroidIntegrationService
import com.monika.dashboard.integration.AndroidIntegrationSocket
import com.monika.dashboard.ui.components.DashboardCard
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.PreferenceSwitchRow
import com.monika.dashboard.ui.components.SectionTitle
import com.monika.dashboard.ui.components.StatusBlock
import kotlinx.coroutines.launch

@Composable
fun DeviceIntegrationsScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val coyote by CoyoteBleController.state.collectAsStateWithLifecycle()
    val serviceRunning by AndroidIntegrationService.running.collectAsStateWithLifecycle()
    var status by rememberSaveable { mutableStateOf("") }
    var limitA by rememberSaveable(coyote.limitA) { mutableStateOf(coyote.limitA.toString()) }
    var limitB by rememberSaveable(coyote.limitB) { mutableStateOf(coyote.limitB.toString()) }
    var selectedWaveform by rememberSaveable { mutableStateOf("pulse_mid") }
    var waveformMenuExpanded by remember { mutableStateOf(false) }
    var accountingSyncing by remember { mutableStateOf(false) }

    val permissionsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { grants ->
        if (grants.values.all { it }) {
            AndroidIntegrationService.start(context)
            CoyoteBleController.startScan()
        } else {
            status = context.getString(R.string.integration_bluetooth_permission_denied)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        DashboardCard(tone = if (serviceRunning) DashboardTone.Good else DashboardTone.Neutral) {
            SectionTitle(
                title = stringResource(R.string.integration_service_title),
                meta = stringResource(if (serviceRunning) R.string.integration_service_running else R.string.integration_service_stopped),
            )
            Text(stringResource(R.string.integration_service_body))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = {
                        AndroidIntegrationService.start(context)
                        status = context.getString(R.string.integration_service_starting)
                    },
                    enabled = !serviceRunning,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringResource(R.string.integration_service_start))
                }
                OutlinedButton(
                    onClick = { AndroidIntegrationService.stop(context) },
                    enabled = serviceRunning,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringResource(R.string.integration_service_stop))
                }
            }
        }

        DashboardCard(tone = if (coyote.connected) DashboardTone.Good else DashboardTone.Info) {
            SectionTitle(
                title = stringResource(R.string.coyote_title),
                meta = when {
                    coyote.connected -> stringResource(R.string.coyote_connected)
                    coyote.connecting -> stringResource(R.string.coyote_connecting)
                    else -> stringResource(R.string.coyote_disconnected)
                },
            )
            Text(stringResource(R.string.coyote_safety_body))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = {
                        val permissions = bluetoothPermissions()
                        if (permissions.isEmpty()) {
                            AndroidIntegrationService.start(context)
                            CoyoteBleController.startScan()
                        } else {
                            permissionsLauncher.launch(permissions)
                        }
                    },
                    enabled = !coyote.scanning,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringResource(if (coyote.scanning) R.string.coyote_scanning else R.string.coyote_scan))
                }
                OutlinedButton(
                    onClick = { CoyoteBleController.disconnect() },
                    enabled = coyote.connected || coyote.connecting,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringResource(R.string.coyote_disconnect))
                }
            }

            coyote.discoveredDevices.forEach { device ->
                OutlinedButton(
                    onClick = { AndroidIntegrationService.connect(context, device.address) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("${device.name} · ${device.generation.name} · ${device.rssi} dBm")
                }
            }

            if (coyote.connected) {
                StatusBlock(
                    text = stringResource(
                        R.string.coyote_state_format,
                        coyote.deviceName,
                        coyote.batteryPercent?.let { "$it%" } ?: "—",
                        coyote.strengthA,
                        coyote.strengthB,
                    ),
                    tone = DashboardTone.Good,
                )
                PreferenceSwitchRow(
                    checked = coyote.remoteControlEnabled,
                    title = stringResource(R.string.coyote_remote_control_title),
                    body = stringResource(R.string.coyote_remote_control_body),
                    onChange = {
                        CoyoteBleController.setRemoteControlEnabled(it)
                        AndroidIntegrationSocket.sendStatus()
                    },
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = limitA,
                        onValueChange = { limitA = it.filter(Char::isDigit).take(3) },
                        modifier = Modifier.weight(1f),
                        label = { Text(stringResource(R.string.coyote_limit_a)) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = limitB,
                        onValueChange = { limitB = it.filter(Char::isDigit).take(3) },
                        modifier = Modifier.weight(1f),
                        label = { Text(stringResource(R.string.coyote_limit_b)) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true,
                    )
                }
                Button(
                    onClick = {
                        CoyoteBleController.updateLimits(
                            limitA.toIntOrNull()?.coerceIn(0, CoyoteSafetyPolicy.MAX_STRENGTH)
                                ?: CoyoteSafetyPolicy.DEFAULT_USER_LIMIT,
                            limitB.toIntOrNull()?.coerceIn(0, CoyoteSafetyPolicy.MAX_STRENGTH)
                                ?: CoyoteSafetyPolicy.DEFAULT_USER_LIMIT,
                        )
                        AndroidIntegrationSocket.sendStatus()
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.coyote_save_limits))
                }

                Column {
                    TextButton(onClick = { waveformMenuExpanded = true }) {
                        Text(
                            stringResource(
                                R.string.coyote_waveform_format,
                                waveformLabel(selectedWaveform),
                            ),
                        )
                    }
                    DropdownMenu(
                        expanded = waveformMenuExpanded,
                        onDismissRequest = { waveformMenuExpanded = false },
                    ) {
                        CoyoteWaveforms.all.forEach { waveform ->
                            DropdownMenuItem(
                                text = { Text(waveformLabel(waveform.id)) },
                                onClick = {
                                    selectedWaveform = waveform.id
                                    waveformMenuExpanded = false
                                },
                            )
                        }
                    }
                }

                CoyoteChannelControls(
                    label = stringResource(R.string.coyote_channel_a),
                    strength = coyote.strengthA,
                    running = coyote.waveActiveA,
                    actions = CoyoteChannelActions(
                        onStart = { status = coyoteOutcomeText(context, CoyoteBleController.start(CoyoteChannel.A, 5, selectedWaveform).reason) },
                        onDecrease = { status = coyoteOutcomeText(context, CoyoteBleController.adjust(CoyoteChannel.A, -5).reason) },
                        onIncrease = { status = coyoteOutcomeText(context, CoyoteBleController.adjust(CoyoteChannel.A, 5).reason) },
                        onChangeWave = { status = coyoteOutcomeText(context, CoyoteBleController.changeWave(CoyoteChannel.A, selectedWaveform).reason) },
                        onStop = { status = coyoteOutcomeText(context, CoyoteBleController.stop(CoyoteChannel.A).reason) },
                    ),
                )
                CoyoteChannelControls(
                    label = stringResource(R.string.coyote_channel_b),
                    strength = coyote.strengthB,
                    running = coyote.waveActiveB,
                    actions = CoyoteChannelActions(
                        onStart = { status = coyoteOutcomeText(context, CoyoteBleController.start(CoyoteChannel.B, 5, selectedWaveform).reason) },
                        onDecrease = { status = coyoteOutcomeText(context, CoyoteBleController.adjust(CoyoteChannel.B, -5).reason) },
                        onIncrease = { status = coyoteOutcomeText(context, CoyoteBleController.adjust(CoyoteChannel.B, 5).reason) },
                        onChangeWave = { status = coyoteOutcomeText(context, CoyoteBleController.changeWave(CoyoteChannel.B, selectedWaveform).reason) },
                        onStop = { status = coyoteOutcomeText(context, CoyoteBleController.stop(CoyoteChannel.B).reason) },
                    ),
                )
                Button(
                    onClick = {
                        status = coyoteOutcomeText(context, CoyoteBleController.emergencyStop().reason)
                        AndroidIntegrationSocket.sendStatus()
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.coyote_emergency_stop))
                }
            }
            if (coyote.error.isNotBlank()) StatusBlock(coyote.error, tone = DashboardTone.Warn)
        }

        DashboardCard {
            SectionTitle(stringResource(R.string.accounting_title))
            Text(stringResource(R.string.accounting_body))
            Button(
                onClick = {
                    accountingSyncing = true
                    scope.launch {
                        val result = AccountingSyncCoordinator(context).syncRecent()
                        status = if (result.error.isBlank()) {
                            context.getString(R.string.accounting_sync_success, result.accepted, result.skipped)
                        } else {
                            result.error
                        }
                        accountingSyncing = false
                        AndroidIntegrationSocket.sendStatus()
                    }
                },
                enabled = !accountingSyncing,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(if (accountingSyncing) R.string.accounting_syncing else R.string.accounting_sync_now))
            }
        }

        if (status.isNotBlank()) StatusBlock(status, tone = DashboardTone.Neutral)
    }
}

@Composable
private fun CoyoteChannelControls(
    label: String,
    strength: Int,
    running: Boolean,
    actions: CoyoteChannelActions,
) {
    SectionTitle(label, meta = if (running) "$strength" else "0")
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        OutlinedButton(onClick = actions.onStart, enabled = !running, modifier = Modifier.weight(1f)) { Text("5") }
        OutlinedButton(onClick = actions.onDecrease, enabled = running, modifier = Modifier.weight(1f)) { Text("−5") }
        OutlinedButton(onClick = actions.onIncrease, enabled = running, modifier = Modifier.weight(1f)) { Text("+5") }
        OutlinedButton(onClick = actions.onChangeWave, enabled = running, modifier = Modifier.weight(1f)) {
            Text(stringResource(R.string.coyote_change_wave))
        }
        OutlinedButton(onClick = actions.onStop, modifier = Modifier.weight(1f)) {
            Text(stringResource(R.string.coyote_stop))
        }
    }
}

private data class CoyoteChannelActions(
    val onStart: () -> Unit,
    val onDecrease: () -> Unit,
    val onIncrease: () -> Unit,
    val onChangeWave: () -> Unit,
    val onStop: () -> Unit,
)

private fun bluetoothPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> arrayOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_CONNECT,
    )
    else -> arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
}

@Composable
private fun waveformLabel(id: String): String = stringResource(
    when (id) {
        "breath" -> R.string.coyote_wave_breath
        "tide" -> R.string.coyote_wave_tide
        "pulse_low" -> R.string.coyote_wave_pulse_low
        "pulse_high" -> R.string.coyote_wave_pulse_high
        "tap" -> R.string.coyote_wave_tap
        else -> R.string.coyote_wave_pulse_mid
    },
)

private fun coyoteOutcomeText(context: android.content.Context, reason: String): String = context.getString(
    when (reason) {
        "applied" -> R.string.coyote_result_applied
        "strength_clamped" -> R.string.coyote_result_strength_clamped
        "coyote_not_connected" -> R.string.coyote_result_not_connected
        "coyote_channel_not_running" -> R.string.coyote_result_channel_not_running
        "already_disconnected" -> R.string.coyote_result_already_disconnected
        "remote_control_not_enabled" -> R.string.coyote_result_remote_disabled
        "gatt_write_not_confirmed" -> R.string.coyote_result_write_unconfirmed
        "unsupported_coyote_action" -> R.string.coyote_result_unsupported
        else -> R.string.coyote_result_failed
    },
    reason,
)
