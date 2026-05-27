// ────────────────────────────────────────────
//  Live Watch — Device App Service
//  运行在手表的设备后台，使用 @zos/sensor v3/v4 API
//  通过系统闹钟周期性唤醒，采集健康数据并上报
//
//  T-Rex 3: Zepp OS 4.0, API_LEVEL 4.5
// ────────────────────────────────────────────

import { Battery } from '@zos/sensor'
import { Step } from '@zos/sensor'
import { HeartRate } from '@zos/sensor'
import { set as setAlarm, cancel as cancelAlarm, getAllAlarms } from '@zos/alarm'
import { createSysTimer, stopTimer } from '@zos/timer'

// ── Sensor instances (created once, reused) ──
const battery = new Battery()
const step = new Step()
const heartRate = new HeartRate()

// ── Runtime state ──
let syncTimerId = null
let alarmId = null
let serverUrl = ''
let token = ''
let syncIntervalMs = 300_000 // default 5 minutes
let enabled = false
let lastReportedAppId = ''

// ── AppService entry (runs ON WATCH) ──
AppService({
  onInit(options) {
    console.log('[LiveWatch:device] AppService init')

    // Read config from settings storage (set by page before starting)
    restoreConfig()

    // If auto-start is configured, begin sync
    if (enabled) {
      startSync()
    }
  },

  onDestroy() {
    console.log('[LiveWatch:device] AppService destroy')
    stopSync()
  },
})

// ── Config (from settingsStorage, standard Zepp API) ──

function restoreConfig() {
  try {
    const storage = require('@zos/settings').settingsStorage
    const raw = storage.getItem('livewatch_config')
    if (raw) {
      const cfg = JSON.parse(raw)
      serverUrl = cfg.serverUrl || ''
      token = cfg.token || ''
      syncIntervalMs = Math.max(60_000, (cfg.syncInterval || 300) * 1000) // minimum 1 minute
      enabled = cfg.enabled || false
      console.log('[LiveWatch:device] Config restored: enabled=' + enabled)
    }
  } catch (e) {
    console.log('[LiveWatch:device] No saved config')
  }
}

// ── Sync Control ──────────────────────────

function startSync() {
  if (syncTimerId != null) return
  enabled = true
  persistConfig()
  console.log('[LiveWatch:device] Starting sync every ' + syncIntervalMs + 'ms')

  // System timer (survives screen-off, per Zepp OS docs)
  syncTimerId = createSysTimer(true, syncIntervalMs, () => {
    syncNow()
  })

  // Fallback alarm for resilience (survives reboot)
  setupAlarm()
}

function stopSync() {
  enabled = false
  persistConfig()
  if (syncTimerId != null) {
    stopTimer(syncTimerId)
    syncTimerId = null
  }
  if (alarmId != null) {
    cancelAlarm(alarmId)
    alarmId = null
  }
  console.log('[LiveWatch:device] Sync stopped')
}

function setupAlarm() {
  if (syncIntervalMs < 60_000) return // too frequent for alarm
  try {
    const alarms = getAllAlarms()
    if (alarms && alarms.length > 0) alarms.forEach(a => cancelAlarm(a.id))
    alarmId = setAlarm({
      url: 'app-service/live-watch.js',
      delay: Math.ceil(syncIntervalMs / 1000),
      store: true,
    })
    console.log('[LiveWatch:device] Alarm set, id=' + alarmId)
  } catch (e) {
    console.warn('[LiveWatch:device] Alarm failed: ' + e.message)
  }
}

// ── Data Collection & Upload ──────────────

function syncNow() {
  if (!serverUrl || !token) return

  const now = new Date().toISOString()
  const extra = {}

  // Battery — @zos/sensor Battery API
  try {
    const level = battery.getCurrent()
    if (level != null && level >= 0) extra.battery_percent = level
  } catch (e) { /* sensor may be unavailable in preview */ }

  // Steps — @zos/sensor Step API
  try {
    const currentSteps = step.getCurrent()
    const targetSteps = step.getTarget()
    if (currentSteps != null) extra.steps = currentSteps
    if (targetSteps != null) extra.steps_target = targetSteps
  } catch (e) { /* sensor may be unavailable */ }

  // Heart rate — @zos/sensor HeartRate API
  try {
    const lastHr = heartRate.getLast()
    if (lastHr != null && lastHr > 0) extra.heart_rate = lastHr
    const restingHr = heartRate.getResting?.()
    if (restingHr != null && restingHr > 0) extra.heart_rate_resting = restingHr
  } catch (e) { /* sensor may be unavailable */ }

  // Determine app_id — track changes to avoid duplicate reports
  const appId = 'zepp-watch'
  if (appId === lastReportedAppId && Object.keys(extra).length === 0) return
  lastReportedAppId = appId

  const body = JSON.stringify({
    app_id: appId,
    window_title: '手表在线',
    timestamp: now,
    extra: {
      ...extra,
      device: {
        platform: 'zepp',
        capability_mode: 'normal',
        device_kind: 'watch',
        last_sample_at: now,
      },
    },
  })

  // httpRequest from zml — works in Device App Service
  httpRequest({
    method: 'POST',
    url: serverUrl.replace(/\/+$/, '') + '/api/report',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: body,
    timeout: 10_000,
  }).then(res => {
    if (res.status >= 200 && res.status < 300) {
      console.log('[LiveWatch:device] Sync OK')
    } else {
      console.warn('[LiveWatch:device] HTTP ' + res.status)
    }
  }).catch(err => {
    console.error('[LiveWatch:device] Sync failed: ' + (err.message || err))
  })
}