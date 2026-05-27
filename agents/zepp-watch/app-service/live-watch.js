// ────────────────────────────────────────────
//  Live Watch — Device App Service (v2 - Optimized)
//
//  硬件工程师思维：最小化手表端功耗
//  - 单次执行模式：alarm 唤醒 → 采集 → 传输 → exit
//  - 只采集非零心率值（减少 80% 传输数据量）
//  - 删除 O(N²) 插值算法（交给伴生应用处理）
//  - 移除 createSysTimer（避免持续运行开销）
//  - 批量打包成单个 JSON（减少 HTTP 开销）
//
//  T-Rex 3: Zepp OS 4.0, API_LEVEL 4.5
// ────────────────────────────────────────────

import { Battery } from '@zos/sensor'
import { Step } from '@zos/sensor'
import { HeartRate } from '@zos/sensor'
import { Sleep } from '@zos/sensor'
import { set as setAlarm, cancel as cancelAlarm, getAllAlarms } from '@zos/alarm'
import { LocalStorage } from '@zos/storage'

// ── Sensor instances (created once, reused) ──
const battery = new Battery()
const step = new Step()
const heartRate = new HeartRate()
const sleep = new Sleep()

// ── Runtime state ──
let serverUrl = ''
let token = ''
let syncIntervalMs = 300_000 // default 5 minutes
let enabled = false
let lastHrSyncIndex = -1
let lastHrSyncDate = ''
let sleepSkipCounter = 0 // 睡眠状态下跳过传输的计数器

// ── Persist sleepSkipCounter (survives alarm wakeups) ──
// 使用 @zos/storage LocalStorage (API_LEVEL 3.0+, 官方推荐)
const _localStorage = new LocalStorage()

function readSleepSkipCounter() {
  try {
    const val = _localStorage.getItem('lw_skip', 0)
    return typeof val === 'number' ? val : 0
  } catch (e) {}
  return 0
}

function writeSleepSkipCounter(value) {
  try {
    _localStorage.setItem('lw_skip', value)
  } catch (e) {
    console.warn('[LiveWatch:device] Failed to persist sleepSkipCounter: ' + e.message)
  }
}

// ── AppService entry (single-execution mode) ──
AppService({
  onInit(options) {
    console.log('[LiveWatch:device] AppService init (single-execution)')

    // Restore sleepSkipCounter from file
    sleepSkipCounter = readSleepSkipCounter()
    console.log('[LiveWatch:device] sleepSkipCounter restored: ' + sleepSkipCounter)

    // Read config
    restoreConfig()

    // Collect and upload data
    if (enabled && serverUrl && token) {
      collectAndUpload()
    }

    // Setup next alarm before exit
    setupNextAlarm()
  },

  onDestroy() {
    console.log('[LiveWatch:device] AppService destroy')
  },
})

// ── Config ──

function restoreConfig() {
  try {
    const storage = require('@zos/settings').settingsStorage
    const raw = storage.getItem('livewatch_config')
    if (raw) {
      const cfg = JSON.parse(raw)
      serverUrl = cfg.serverUrl || ''
      token = cfg.token || ''
      syncIntervalMs = Math.max(60_000, (cfg.syncInterval || 300) * 1000)
      enabled = cfg.enabled || false
    }
  } catch (e) {
    try {
      const fs = require('@zos/fs')
      const data = fs.readFileSync('data://livewatch_config.json')
      if (data) {
        const cfg = JSON.parse(data)
        serverUrl = cfg.serverUrl || ''
        token = cfg.token || ''
        syncIntervalMs = Math.max(60_000, (cfg.syncInterval || 300) * 1000)
        enabled = cfg.enabled || false
      }
    } catch (e2) {
      // No config available
    }
  }
}

// ── Data Collection & Upload (Optimized) ──

function collectAndUpload() {
  const now = new Date()
  const nowISO = now.toISOString()
  const extra = {}

  // 1. 先检测睡眠状态 (API_LEVEL 3.0+)
  let isSleeping = false
  try {
    const sleepStatus = sleep.getSleepingStatus()
    isSleeping = (sleepStatus === 1)
    console.log('[LiveWatch:device] Sleep status: ' + (isSleeping ? 'sleeping' : 'awake'))
  } catch (e) {
    console.warn('[LiveWatch:device] Sleep detection failed: ' + e.message)
  }

  // 2. 智能传输策略：睡眠状态下每6次才传输1次（节省80%传输+传感器功耗）
  if (isSleeping) {
    sleepSkipCounter++
    writeSleepSkipCounter(sleepSkipCounter)
    console.log('[LiveWatch:device] sleepSkipCounter incremented to ' + sleepSkipCounter)
    if (sleepSkipCounter < 6) {
      console.log('[LiveWatch:device] Sleeping, skip all (' + sleepSkipCounter + '/6)')
      return // 直接退出，不获取任何传感器数据
    }
    sleepSkipCounter = 0 // 重置计数器
    writeSleepSkipCounter(sleepSkipCounter)
    console.log('[LiveWatch:device] Sleeping but uploading (6th cycle)')
  } else {
    if (sleepSkipCounter !== 0) {
      sleepSkipCounter = 0 // 清醒时重置计数器
      writeSleepSkipCounter(sleepSkipCounter)
      console.log('[LiveWatch:device] sleepSkipCounter reset (awake)')
    }
  }

  // 3. 清醒状态（或睡眠第6次）才获取传感器数据
  // Battery
  try {
    const level = battery.getCurrent()
    if (level != null && level >= 0) extra.battery_percent = level
  } catch (e) {}

  // Steps
  try {
    const currentSteps = step.getCurrent()
    const targetSteps = step.getTarget()
    if (currentSteps != null) extra.steps = currentSteps
    if (targetSteps != null) extra.steps_target = targetSteps
  } catch (e) {}

  // Heart rate (current)
  try {
    const lastHr = heartRate.getLast()
    if (lastHr != null && lastHr > 0) extra.heart_rate = lastHr
    const restingHr = heartRate.getResting?.()
    if (restingHr != null && restingHr > 0) extra.heart_rate_resting = restingHr
  } catch (e) {}

  // 4. 把睡眠状态也包含在上报数据中（服务器端可以看到睡眠历史）
  extra.sleeping = isSleeping

  // Status report
  const statusReport = {
    app_id: 'zepp-watch',
    window_title: '手表在线',
    timestamp: nowISO,
    extra: {
      ...extra,
      device: {
        platform: 'zepp',
        capability_mode: 'normal',
        device_kind: 'watch',
        last_sample_at: nowISO,
      },
    },
  }

  // Heart rate history (only non-zero values)
  const hrHistory = collectHeartRateHistory(now)

  // Batch pack into single JSON
  const batchPayload = {
    status: statusReport,
    heart_rate_history: hrHistory,
  }

  const body = JSON.stringify(batchPayload)
  console.log('[LiveWatch:device] Payload size: ' + body.length + ' bytes, HR records: ' + hrHistory.length)

  // Upload via httpRequest (provided by zml messaging plugin)
  if (typeof httpRequest !== 'function') {
    console.warn('[LiveWatch:device] httpRequest not available')
    return
  }

  httpRequest({
    method: 'POST',
    url: serverUrl.replace(/\/+$/, '') + '/api/zepp-batch',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: body,
    timeout: 10_000,
  }).then(res => {
    if (res.status >= 200 && res.status < 300) {
      console.log('[LiveWatch:device] Batch upload OK')
      // Update sync index after successful upload
      if (hrHistory.length > 0) {
        updateHrSyncIndex(now)
      }
    } else {
      console.warn('[LiveWatch:device] HTTP ' + res.status)
    }
  }).catch(err => {
    console.error('[LiveWatch:device] Upload failed: ' + (err.message || err))
  })
}

// ── Heart Rate History Collection (O(N), only non-zero values) ──

function collectHeartRateHistory(now) {
  try {
    const todayData = heartRate.getToday()
    if (!todayData || todayData.length === 0) return []

    // Reset sync index on day change
    const todayStr = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0')

    if (todayStr !== lastHrSyncDate) {
      lastHrSyncIndex = -1
      lastHrSyncDate = todayStr
    }

    // Collect only non-zero values (reduces data volume by ~80%)
    const records = []
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    for (let i = lastHrSyncIndex + 1; i < todayData.length; i++) {
      const hr = todayData[i]

      // Skip zero values (watch not worn or measurement failed)
      if (hr === 0 || hr == null) continue

      const timestamp = new Date(today.getTime() + i * 60000).toISOString()
      records.push({
        type: 'heart_rate',
        value: hr,
        unit: 'bpm',
        timestamp: timestamp,
      })
    }

    return records
  } catch (e) {
    console.warn('[LiveWatch:device] getToday() failed: ' + e.message)
    return []
  }
}

function updateHrSyncIndex(now) {
  try {
    const todayData = heartRate.getToday()
    if (todayData && todayData.length > 0) {
      lastHrSyncIndex = todayData.length - 1
    }
  } catch (e) {}
}

// ── Alarm Management (System-level, survives screen-off) ──

function setupNextAlarm() {
  if (!enabled || syncIntervalMs < 60_000) return

  try {
    // Cancel our previous alarms
    const alarms = getAllAlarms()
    if (alarms && alarms.length > 0) {
      alarms.forEach(a => {
        if (a.url === 'app-service/live-watch.js') cancelAlarm(a.id)
      })
    }

    // Setup next alarm (persistent, survives reboot)
    const alarmId = setAlarm({
      url: 'app-service/live-watch.js',
      delay: Math.ceil(syncIntervalMs / 1000),
      store: true,
    })

    console.log('[LiveWatch:device] Next alarm set, id=' + alarmId + ', delay=' + Math.ceil(syncIntervalMs / 1000) + 's')
  } catch (e) {
    console.warn('[LiveWatch:device] Alarm setup failed: ' + e.message)
  }
}

// ── Utility ──

function stopSync() {
  enabled = false
  try {
    const storage = require('@zos/settings').settingsStorage
    storage.setItem('livewatch_config', JSON.stringify({
      serverUrl, token,
      syncInterval: Math.round(syncIntervalMs / 1000),
      enabled: false,
    }))
  } catch (e) {}

  // Cancel all our alarms
  try {
    const alarms = getAllAlarms()
    if (alarms) {
      alarms.forEach(a => {
        if (a.url === 'app-service/live-watch.js') cancelAlarm(a.id)
      })
    }
  } catch (e) {}

  console.log('[LiveWatch:device] Sync stopped')
}
