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
let syncIntervalMs = 30_000
let enabled = false
let lastReportedAppId = ''

// ── AppService entry ──
AppService({
  onInit(options) {
    console.log('[LiveWatch:device] AppService init, options=' + options)

    // Restore saved config (via file system or settings storage)
    restoreConfig()

    // If woken by alarm, the event parameter indicates the trigger source
    if (options && options.indexOf('event=alarm') >= 0) {
      // Woken by alarm — do a sync and exit
      syncNow()
      return
    }

    if (options && options.indexOf('event=start') >= 0) {
      startSync()
    }
  },

  onDestroy() {
    console.log('[LiveWatch:device] AppService destroy')
    stopSync()
  },
})

// ── Config ────────────────────────────────

function restoreConfig() {
  try {
    const fs = require('@zos/fs')
    const data = fs.readFileSync('data://livewatch_config.json')
    if (data) {
      const cfg = JSON.parse(data)
      serverUrl = cfg.serverUrl || ''
      token = cfg.token || ''
      syncIntervalMs = (cfg.syncInterval || 30) * 1000
      enabled = cfg.enabled || false
      console.log('[LiveWatch:device] Config restored: enabled=' + enabled)
    }
  } catch (e) {
    console.log('[LiveWatch:device] No saved config')
  }
}

function persistConfig() {
  try {
    const fs = require('@zos/fs')
    fs.writeFileSync('data://livewatch_config.json', JSON.stringify({
      serverUrl, token,
      syncInterval: Math.round(syncIntervalMs / 1000),
      enabled,
    }))
  } catch (e) {
    console.warn('[LiveWatch:device] persistConfig failed: ' + e.message)
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

// ── Side-service message handler (for page.js communication) ──
AppSideService({
  onRequest(req, res) {
    const { method } = req
    switch (method) {
      case 'START':
        serverUrl = req.params?.serverUrl || serverUrl
        token = req.params?.token || token
        syncIntervalMs = (req.params?.syncInterval || 30) * 1000
        startSync()
        res(null, { ok: true, status: 'started' })
        break
      case 'STOP':
        stopSync()
        res(null, { ok: true, status: 'stopped' })
        break
      case 'CONFIG':
        serverUrl = req.params?.serverUrl || serverUrl
        token = req.params?.token || token
        syncIntervalMs = (req.params?.syncInterval || 30) * 1000
        persistConfig()
        if (enabled) { stopSync(); startSync() }
        res(null, { ok: true })
        break
      default:
        res({ error: 'unknown method' }, null)
    }
  },
})