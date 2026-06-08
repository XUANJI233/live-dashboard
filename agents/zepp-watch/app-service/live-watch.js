// ────────────────────────────────────────────
//  Live Watch — Device App Service (v2 - Optimized)
//
//  硬件工程师思维：最小化手表端功耗
//  - 单次执行模式：alarm 唤醒 → 采集 → 传输，按系统策略自回收
//  - 只采集非零心率值（减少 80% 传输数据量）
//  - 删除 O(N²) 插值算法（交给伴生应用用线性流水线处理）
//  - 移除 createSysTimer（避免持续运行开销）
//  - 批量打包成单个 JSON（减少 HTTP 开销）
//
//  T-Rex 3: Zepp OS 4.0, API_LEVEL 4.5
// ────────────────────────────────────────────

import { BasePage } from '@zeppos/zml/base-page'
import { Battery } from '@zos/sensor'
import { Step } from '@zos/sensor'
import { HeartRate } from '@zos/sensor'
import { Sleep } from '@zos/sensor'
import { BloodOxygen } from '@zos/sensor'
import { BodyTemperature } from '@zos/sensor'
import { set as setAlarm, cancel as cancelAlarm, getAllAlarms } from '@zos/alarm'
import { LocalStorage } from '@zos/storage'
import { readFileSync } from '@zos/fs'

// ── Sensor instances (created once, reused) ──
const battery = new Battery()
const step = new Step()
const heartRate = new HeartRate()
const sleep = new Sleep()
const bloodOxygen = new BloodOxygen()
const bodyTemperature = new BodyTemperature()

// ── Runtime state ──
let serverUrl = ''
let token = ''
let syncIntervalMs = 300_000 // default 5 minutes
let enabled = false
let lastHrSyncIndex = -1
let lastHrSyncDate = ''
let lastSpo2SyncTime = 0 // 上次同步的血氧时间戳 (秒), 由 LocalStorage 恢复
let lastSpo2SyncDate = '' // 上次同步日期，跨日重置用
let lastTempSyncIndex = -1 // 上次同步的体温索引 (每5分钟一个, 共288个)
let lastTempSyncDate = '' // 上次同步日期，跨日重置用
let nextAlarmDelayMs = 0
let sleepCadenceForCurrentCycle = false
let sensorHeartRate = true
let sensorBattery = true
let sensorStep = true
let sensorSleep = true
let sensorBodyTemp = true
let sensorSpo2 = false
let sensorStress = false

const MAX_HR_RECORDS_PER_SYNC = 30
const MAX_SPO2_RECORDS_PER_SYNC = 12
const MAX_TEMP_RECORDS_PER_SYNC = 24
const MIN_SYNC_INTERVAL_SECONDS = 60
const DEFAULT_SYNC_INTERVAL_SECONDS = 300
const MAX_SYNC_INTERVAL_SECONDS = 900
const SLEEP_UPLOAD_INTERVAL_MS = 30 * 60_000
const CONFIG_KEY = 'lw_cfg'
const ALARM_ID_KEY = 'lw_alarm_id'
const PENDING_PAYLOADS_KEY = 'lw_pending_payloads'
const PREVIOUS_PAYLOAD_KEY = 'lw_prev_payload'
const MAX_PENDING_PAYLOADS = 24
const MANUAL_FULL_SYNC_KEY = 'lw_manual_full'

// 使用 @zos/storage LocalStorage (API_LEVEL 3.0+, 官方推荐)
const _localStorage = new LocalStorage()

function readNumber(key, fallback) {
  try {
    const val = _localStorage.getItem(key, fallback)
    return typeof val === 'number' ? val : fallback
  } catch (e) {}
  return fallback
}

function writeNumber(key, value) {
  try {
    _localStorage.setItem(key, value)
  } catch (e) {
    console.log('[LiveWatch:device] Failed to persist ' + key + ': ' + e.message)
  }
}

function readString(key, fallback) {
  try {
    const val = _localStorage.getItem(key, fallback)
    return typeof val === 'string' ? val : fallback
  } catch (e) {}
  return fallback
}

function clampSyncIntervalSeconds(value) {
  const numeric = Number(value)
  const seconds = Number.isFinite(numeric) ? numeric : DEFAULT_SYNC_INTERVAL_SECONDS
  return Math.max(MIN_SYNC_INTERVAL_SECONDS, Math.min(MAX_SYNC_INTERVAL_SECONDS, seconds))
}

function writeString(key, value) {
  try {
    _localStorage.setItem(key, value)
  } catch (e) {
    console.log('[LiveWatch:device] Failed to persist ' + key + ': ' + e.message)
  }
}

// ── Persist lastSpo2SyncTime (survives alarm wakeups) ──
function readLastSpo2SyncTime() {
  try {
    const val = _localStorage.getItem('lw_spo2_time', 0)
    return typeof val === 'number' ? val : 0
  } catch (e) {}
  return 0
}

function writeLastSpo2SyncTime(value) {
  try {
    _localStorage.setItem('lw_spo2_time', value)
  } catch (e) {
    console.log('[LiveWatch:device] Failed to persist lastSpo2SyncTime: ' + e.message)
  }
}

// ── AppService entry (single-execution mode) ──
//
// ZML exposes call/request through BasePage. AppService can use the same
// wrapper for the short BLE handoff to the phone side-service while still
// exiting after one collection cycle.
AppService(
  BasePage({
  onInit(options) {
    console.log('[LiveWatch:device] AppService init (single-execution)')

    // Restore lastSpo2SyncTime from file
    lastSpo2SyncTime = readLastSpo2SyncTime()
    lastSpo2SyncDate = readString('lw_spo2_date', '')
    lastHrSyncIndex = readNumber('lw_hr_index', -1)
    lastHrSyncDate = readString('lw_hr_date', '')
    lastTempSyncIndex = readNumber('lw_temp_index', -1)
    lastTempSyncDate = readString('lw_temp_date', '')
    console.log('[LiveWatch:device] lastSpo2SyncTime restored: ' + lastSpo2SyncTime)

    // Read config from local storage first. Companion config sync is deferred
    // until an upload cycle so skipped sleep cycles do not wake BLE just to ask.
    restoreConfig()

    const manualFullSync = readManualFullSyncRequest()
    const shouldSync = (enabled || manualFullSync) && serverUrl && token
    let uploadQueued = false

    // Collect and upload data. Manual upload is one-shot and does not enable
    // recurring background sync.
    if (shouldSync) {
      uploadQueued = collectAndUpload({ forceFull: manualFullSync, messenger: this })
    }

    if (enabled && serverUrl && token) {
      setupNextAlarm(alarmDelayForCurrentCycle())
    }

    if (uploadQueued || !shouldSync) {
      requestConfigFromCompanion(this)
    }
  },

  onDestroy() {
    console.log('[LiveWatch:device] AppService destroy')
  },
  }),
)

// ── Config ──

function restoreConfig() {
  const localCfg = readLocalConfig()
  if (localCfg) {
    applyConfig(localCfg)
    return
  }
  try {
    const data = readFileSync({ path: 'data://livewatch_config.json' })
    if (data) {
      applyConfig(JSON.parse(data))
    }
  } catch (e) {
    // No config available
  }
}

function readLocalConfig() {
  try {
    const raw = _localStorage.getItem(CONFIG_KEY, '')
    if (!raw) return null
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (e) {}
  return null
}

function writeLocalConfig(cfg) {
  try {
    _localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg))
  } catch (e) {}
}

function currentConfigSnapshot() {
  return {
    serverUrl: serverUrl,
    token: token,
    syncInterval: Math.round(syncIntervalMs / 1000),
    enabled: enabled,
    sensorHeartRate: sensorHeartRate,
    sensorBattery: sensorBattery,
    sensorStep: sensorStep,
    sensorSleep: sensorSleep,
    sensorBodyTemp: sensorBodyTemp,
    sensorSpo2: sensorSpo2,
    sensorStress: sensorStress,
  }
}

function requestConfigFromCompanion(messenger) {
  if (!messenger || typeof messenger.request !== 'function') return
  try {
    const pending = messenger.request({ method: 'GET_CONFIG' })
    if (pending && typeof pending.then === 'function') {
      pending.then(function (cfg) {
        if (!cfg || !cfg.serverUrl || !cfg.token) return
        applyConfig(cfg)
        writeLocalConfig(currentConfigSnapshot())
        console.log('[LiveWatch:device] Config synced from companion')
        rescheduleFromConfig()
      }, function (e) {
        console.log('[LiveWatch:device] Config sync failed: ' + ((e && e.message) || e))
        // Even on failure, try to keep the alarm going with existing config
        rescheduleFromConfig()
      })
    }
  } catch (e) {
    console.log('[LiveWatch:device] Config sync unavailable: ' + ((e && e.message) || e))
  }
}

function normalizePayloadQueue(value) {
  if (!value) return []
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(parsed)) return []
  return parsed.filter(function (payload) {
    return payload && payload.s && payload.s.ts
  })
}

function readPreviousPayload() {
  try {
    const raw = _localStorage.getItem(PREVIOUS_PAYLOAD_KEY, '')
    if (!raw) return null
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (e) {}
  return null
}

function writePreviousPayload(payload) {
  try {
    _localStorage.setItem(PREVIOUS_PAYLOAD_KEY, JSON.stringify(payload))
  } catch (e) {}
}

function readPendingPayloads() {
  try {
    const queue = normalizePayloadQueue(_localStorage.getItem(PENDING_PAYLOADS_KEY, ''))
    if (queue.length > 0) return queue
  } catch (e) {}

  const previous = readPreviousPayload()
  return previous && previous.s ? [previous] : []
}

function writePendingPayloads(payloads) {
  try {
    _localStorage.setItem(PENDING_PAYLOADS_KEY, JSON.stringify(payloads.slice(-MAX_PENDING_PAYLOADS)))
  } catch (e) {
    console.log('[LiveWatch:device] Failed to persist payload queue: ' + ((e && e.message) || e))
  }
}

function queuePendingPayload(payload) {
  const pending = readPendingPayloads().filter(function (item) {
    return item && item.s && item.s.ts !== payload.s.ts
  })
  pending.push(payload)
  const trimmed = pending.slice(-MAX_PENDING_PAYLOADS)
  writePendingPayloads(trimmed)
  writePreviousPayload(payload)
  return trimmed
}

function clearPendingPayloads() {
  writePendingPayloads([])
  try {
    _localStorage.setItem(PREVIOUS_PAYLOAD_KEY, '')
  } catch (e) {}
}

function readManualFullSyncRequest() {
  try {
    const value = _localStorage.getItem(MANUAL_FULL_SYNC_KEY, false)
    _localStorage.setItem(MANUAL_FULL_SYNC_KEY, false)
    return value === true || value === 1 || value === '1' || value === 'true'
  } catch (e) {}
  return false
}

function applyConfig(cfg) {
  serverUrl = cleanServerUrl(cfg.serverUrl || '')
  token = cleanToken(cfg.token || '')
  syncIntervalMs = clampSyncIntervalSeconds(cfg.syncInterval) * 1000
  enabled = Boolean(cfg.enabled)
  restoreSensorConfig(cfg)
}

function rescheduleFromConfig() {
  if (enabled && serverUrl && token) {
    setupNextAlarm(alarmDelayForCurrentCycle())
  } else {
    cancelWatchServiceAlarms(true)
  }
}

function alarmDelayForCurrentCycle() {
  return sleepCadenceForCurrentCycle ? SLEEP_UPLOAD_INTERVAL_MS : syncIntervalMs
}

// ── Data Collection & Upload (Optimized) ──

function collectAndUpload(options = {}) {
  const forceFull = Boolean(options.forceFull)
  const now = new Date()
  const nowISO = now.toISOString()
  const extra = {}
  nextAlarmDelayMs = syncIntervalMs
  sleepCadenceForCurrentCycle = false

  // 1. 先检测睡眠状态 (API_LEVEL 3.0+)
  let isSleeping = false
  if (sensorSleep) {
    try {
      const sleepStatus = sleep.getSleepingStatus()
      isSleeping = (sleepStatus === 1)
      console.log('[LiveWatch:device] Sleep status: ' + (isSleeping ? 'sleeping' : 'awake'))
    } catch (e) {
      console.log('[LiveWatch:device] Sleep detection failed: ' + e.message)
    }
  }

  // 2. 智能传输策略：睡眠期按 Zepp Sleep 文档的系统默认更新节奏，
  //    约每 30 分钟唤醒一次；避免普通同步间隔下反复启动 AppService。
  if (isSleeping && !forceFull) {
    nextAlarmDelayMs = SLEEP_UPLOAD_INTERVAL_MS
    sleepCadenceForCurrentCycle = true
    console.log('[LiveWatch:device] Sleeping upload, next alarm in 30 minutes')
  }

  // 3. 清醒状态（或睡眠 30 分钟周期到期）才获取传感器数据
  // Battery
  if (sensorBattery) {
    try {
      const level = battery.getCurrent()
      if (level != null && level >= 0) extra.battery_percent = level
    } catch (e) {}
  }

  // Steps
  if (sensorStep) {
    try {
      const currentSteps = step.getCurrent()
      const targetSteps = step.getTarget()
      if (currentSteps != null) extra.steps = currentSteps
      if (targetSteps != null) extra.steps_target = targetSteps
    } catch (e) {}
  }

  // Heart rate (current)
  if (sensorHeartRate) {
    try {
      const lastHr = heartRate.getLast()
      if (lastHr != null && lastHr > 0) extra.heart_rate = lastHr
      const restingHr = heartRate.getResting?.()
      if (restingHr != null && restingHr > 0) extra.heart_rate_resting = restingHr
    } catch (e) {}
  }

  // 4. 把睡眠状态也包含在上报数据中（服务器端可以看到睡眠历史）
  if (sensorSleep) extra.sleeping = isSleeping

  // ── Build compact payload (short keys, reduced ~84%) ──
  // Compact format: sends minimal data over BLE/HTTP, side-service expands to verbose.
  // s = status, h = HR history [value, minuteIndex], o = SpO2 [value, timeSec],
  // t = temp [value, minuteOffset], sl = sleep summary.

  const unixTs = Math.floor(now.getTime() / 1000)

  const compactStatus = {
    a: 'zw',                       // app_id
    ts: unixTs,                    // timestamp (Unix seconds, no ISO string overhead)
    b: sensorBattery && extra.battery_percent !== undefined ? extra.battery_percent : undefined, // battery
    se: sensorStep && extra.steps !== undefined ? extra.steps : undefined, // steps
    st: sensorStep && extra.steps_target !== undefined ? extra.steps_target : undefined, // steps_target
    sp: sensorSleep ? isSleeping : undefined, // sleeping
    hr: extra.heart_rate ?? 0,     // current heart rate
    hrr: extra.heart_rate_resting ?? 0, // resting HR
    ni: Math.round(nextAlarmDelayMs), // next interval in ms for server energy policy metadata
    d: { p: 'zp' },                // device: { platform: 'zepp' }
  }

  // Compact data arrays (each 85% smaller than verbose)
  const compactHr = sensorHeartRate ? collectHeartRateHistory(now, forceFull) : []
  const compactSpo2 = sensorSpo2 ? collectSpo2History(forceFull ? 24 : 6, forceFull) : []
  const compactTemp = sensorBodyTemp ? collectTempHistory(now, forceFull) : []
  const compactSleep = sensorSleep ? collectSleepDetails(forceFull) : null

  // Compact payload (short keys for ~84% size reduction)
  const compactPayload = {
    s: compactStatus,
    h: compactHr,   // [[value, minuteIndex], ...]
    o: compactSpo2, // [[value, timeSec], ...]
    t: compactTemp, // [[value, minuteOffset], ...]
    sl: compactSleep,
    m: forceFull ? true : undefined,
  }

  const compactSize = JSON.stringify(compactPayload).length
  console.log('[LiveWatch:device] Compact payload: ' + compactSize + ' bytes')

  // Keep a small local queue until the companion acknowledges receipt. Server
  // health rows are deduped by device/type/time, so retrying is safe.
  const payloads = queuePendingPayload(compactPayload)

  // Send compact data to side-service over ZML BLE. Side-service expands and uploads.
  sendToCompanion({ payloads: payloads }, options.messenger)
  return true
}

function sendToCompanion(payload, messenger) {
  return sendToCompanionViaZml(payload, messenger)
}

function sendToCompanionViaZml(payload, messenger) {
  try {
    const sender = messenger && (typeof messenger.request === 'function' || typeof messenger.call === 'function')
      ? messenger
      : null
    if (!sender) {
      console.log('[LiveWatch:device] ZML messenger unavailable')
      return false
    }

    if (typeof sender.request === 'function') {
      const pending = sender.request({
        method: 'BATCH_DATA',
        params: { payload: payload },
      })
      if (pending && typeof pending.then === 'function') {
        pending.then(function (result) {
          if (!result || result.ok !== false) {
            clearPendingPayloads()
            console.log('[LiveWatch:device] ZML batch ack, queue cleared')
          } else {
            console.log('[LiveWatch:device] ZML batch rejected: ' + JSON.stringify(result))
          }
        }, function (e) {
          console.log('[LiveWatch:device] ZML batch failed: ' + ((e && e.message) || e))
        })
      }
      console.log('[LiveWatch:device] ZML batch requested')
      return true
    }

    const pending = sender.call({
      method: 'BATCH_DATA',
      params: { payload: payload },
    })
    if (pending && typeof pending.catch === 'function') {
      pending.catch(function (e) {
        console.log('[LiveWatch:device] ZML batch failed: ' + ((e && e.message) || e))
      })
    }
    console.log('[LiveWatch:device] ZML batch queued')
    return true
  } catch (e) {
    console.log('[LiveWatch:device] ZML messaging unavailable: ' + ((e && e.message) || e))
    return false
  }
}

function cleanServerUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/api\/(?:report|health-data)$/i, '')
    .replace(/\/api$/i, '')
}

function cleanToken(value) {
  return String(value || '').replace(/^Bearer\s+/i, '').trim()
}

function readBool(cfg, key, fallback) {
  return cfg[key] === undefined ? fallback : Boolean(cfg[key])
}

function restoreSensorConfig(cfg) {
  sensorHeartRate = readBool(cfg, 'sensorHeartRate', true)
  sensorBattery = readBool(cfg, 'sensorBattery', true)
  sensorStep = readBool(cfg, 'sensorStep', true)
  sensorSleep = readBool(cfg, 'sensorSleep', true)
  sensorBodyTemp = readBool(cfg, 'sensorBodyTemp', true)
  sensorSpo2 = readBool(cfg, 'sensorSpo2', false)
  sensorStress = readBool(cfg, 'sensorStress', false)
}

// ── Heart Rate History Collection (O(N), only non-zero values) ──

function collectHeartRateHistory(now, forceFull = false) {
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
      writeNumber('lw_hr_index', lastHrSyncIndex)
      writeString('lw_hr_date', lastHrSyncDate)
    }

    // Collect only non-zero values (compact: [value, minuteIndex])
    // minuteIndex = array index from getToday() (0-1439)
    // Saves ~85% vs verbose {type, value, unit, timestamp}
    const records = []

    const startIndex = forceFull ? 0 : lastHrSyncIndex + 1
    for (let i = startIndex; i < todayData.length; i++) {
      const hr = todayData[i]

      // Skip zero values (watch not worn or measurement failed)
      if (hr === 0 || hr == null) continue

      records.push([hr, i])  // compact: [value, minuteIndex]
    }

    if (todayData.length > 0) {
      lastHrSyncIndex = todayData.length - 1
      writeNumber('lw_hr_index', lastHrSyncIndex)
      writeString('lw_hr_date', lastHrSyncDate)
    }

    if (forceFull) return records
    return records.length > MAX_HR_RECORDS_PER_SYNC
      ? records.slice(records.length - MAX_HR_RECORDS_PER_SYNC)
      : records
  } catch (e) {
    console.log('[LiveWatch:device] getToday() failed: ' + e.message)
    return []
  }
}

// ── SpO2 History Collection (getLastFewHour, incremental sync) ──
// getLastDay() 只返回 24 个平均数，不适合详细上报
// getLastFewHour(hour) 返回指定小时内的全部测量数据 {spo2, time}
// 增量同步：只上传 lastSpo2SyncTime 之后的新数据

function collectSpo2History(hours, forceFull = false) {
  try {
    const data = bloodOxygen.getLastFewHour(hours)
    if (!data || data.length === 0) return []

    // 跨日重置
    const today = new Date()
    const todayStr = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0')
    if (todayStr !== lastSpo2SyncDate) {
      lastSpo2SyncTime = 0
      lastSpo2SyncDate = todayStr
      writeLastSpo2SyncTime(0)
      writeString('lw_spo2_date', todayStr)
    }

    const records = []
    let maxTime = lastSpo2SyncTime
    for (const d of data) {
      // Skip invalid readings (spo2=0 means no measurement)
      if (!d || d.spo2 <= 0 || d.spo2 > 100) continue

      // 增量：只取时间戳大于上次同步的
      if (!forceFull && d.time <= lastSpo2SyncTime) continue

      // compact: [value, timeSec] — timeSec is Unix seconds from sensor API
      // Saves ~80% vs verbose {type, value, unit, timestamp}
      records.push([d.spo2, d.time])

      if (d.time > maxTime) maxTime = d.time
    }

    // 更新同步时间戳
    if (maxTime > lastSpo2SyncTime) {
      lastSpo2SyncTime = maxTime
      writeLastSpo2SyncTime(maxTime)
      writeString('lw_spo2_date', todayStr)
    }

    if (forceFull) return records
    return records.length > MAX_SPO2_RECORDS_PER_SYNC
      ? records.slice(records.length - MAX_SPO2_RECORDS_PER_SYNC)
      : records
  } catch (e) {
    console.log('[LiveWatch:device] getLastFewHour() failed: ' + e.message)
    return []
  }
}

// ── Body Temperature History Collection (getToday, incremental sync) ──
// getToday() 返回 288 个点（每5分钟一个），无数据为 -1000
// 增量同步：只上传 lastTempSyncIndex 之后的新数据

function collectTempHistory(now, forceFull = false) {
  try {
    const todayData = bodyTemperature.getToday()
    if (!todayData || todayData.length === 0) return []

    // 跨日重置
    const todayStr = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0')
    if (todayStr !== lastTempSyncDate) {
      lastTempSyncIndex = -1
      lastTempSyncDate = todayStr
      writeNumber('lw_temp_index', lastTempSyncIndex)
      writeString('lw_temp_date', lastTempSyncDate)
    }

    // 只采集新数据
    const records = []

    const startIndex = forceFull ? 0 : lastTempSyncIndex + 1
    for (let i = startIndex; i < todayData.length; i++) {
      const temp = todayData[i]

      // Skip invalid (-1000 means no measurement)
      if (temp <= -999 || temp < 30 || temp > 45) continue

      // compact: [value, minuteOffset] — minuteOffset = i * 5 (每点5分钟)
      // Saves ~85% vs verbose {type, value, unit, timestamp}
      records.push([temp, i * 5])
    }

    // 更新同步索引
    if (todayData.length > 0) {
      lastTempSyncIndex = todayData.length - 1
      writeNumber('lw_temp_index', lastTempSyncIndex)
      writeString('lw_temp_date', lastTempSyncDate)
    }

    if (forceFull) return records
    return records.length > MAX_TEMP_RECORDS_PER_SYNC
      ? records.slice(records.length - MAX_TEMP_RECORDS_PER_SYNC)
      : records
  } catch (e) {
    console.log('[LiveWatch:device] bodyTemperature.getToday() failed: ' + e.message)
    return []
  }
}

function collectSleepDetails(forceFull = false) {
  const details = {}
  try {
    if (forceFull && typeof sleep.updateInfo === 'function') sleep.updateInfo()
  } catch (e) {
    console.log('[LiveWatch:device] sleep.updateInfo() failed: ' + e.message)
  }

  try {
    const info = sleep.getInfo()
    if (info) {
      if (Number.isFinite(info.startTime) && info.startTime >= 0) details.st = info.startTime
      if (Number.isFinite(info.endTime) && info.endTime >= 0) details.en = info.endTime
      if (Number.isFinite(info.totalTime) && info.totalTime > 0) details.du = info.totalTime
      if (Number.isFinite(info.deepTime) && info.deepTime >= 0) details.de = info.deepTime
      if (Number.isFinite(info.score) && info.score >= 0) details.sc = info.score
    }
  } catch (e) {
    console.log('[LiveWatch:device] sleep.getInfo() failed: ' + e.message)
  }

  try {
    const stage = sleep.getStage()
    if (stage && stage.length > 0) details.sg = stage.length
  } catch (e) {}

  try {
    const naps = sleep.getNap()
    if (naps && naps.length > 0) {
      details.np = naps
        .filter((nap) => nap && Number.isFinite(nap.start) && Number.isFinite(nap.stop) && Number.isFinite(nap.length))
        .slice(forceFull ? -6 : -2)
        .map((nap) => [nap.start, nap.stop, nap.length])
    }
  } catch (e) {}

  return Object.keys(details).length > 0 ? details : null
}

// ── Alarm Management (System-level, survives screen-off) ──

function setupNextAlarm(delayMs) {
  if (!enabled || syncIntervalMs < 60_000) {
    cancelWatchServiceAlarms(false)
    return
  }

  try {
    cancelWatchServiceAlarms(true)
    const alarmDelayMs = Number.isFinite(delayMs) ? Math.max(60_000, delayMs) : syncIntervalMs
    const delaySec = Math.ceil(alarmDelayMs / 1000)

    // Setup next alarm (persistent, survives reboot)
    const alarmId = setAlarm({
      url: 'app-service/live-watch',
      delay: delaySec,
      store: true,
    })
    if (alarmId > 0) writeNumber(ALARM_ID_KEY, alarmId)

    console.log('[LiveWatch:device] Next alarm set, id=' + alarmId + ', delay=' + delaySec + 's')
  } catch (e) {
    console.log('[LiveWatch:device] Alarm setup failed: ' + e.message)
  }
}

// ── Utility ──

function stopSync() {
  enabled = false
  try {
    writeLocalConfig({
      serverUrl, token,
      syncInterval: Math.round(syncIntervalMs / 1000),
      enabled: false,
      sensorHeartRate,
      sensorBattery,
      sensorStep,
      sensorSleep,
      sensorBodyTemp,
      sensorSpo2,
      sensorStress,
    })
  } catch (e) {}

  cancelWatchServiceAlarms(true)

  console.log('[LiveWatch:device] Sync stopped')
}

function cancelWatchServiceAlarms(fallbackAll) {
  try {
    const alarmId = readNumber(ALARM_ID_KEY, 0)
    if (alarmId > 0) {
      cancelAlarm(alarmId)
      writeNumber(ALARM_ID_KEY, 0)
      return
    }

    if (fallbackAll) {
      const alarms = getAllAlarms()
      if (alarms) {
        alarms.forEach(a => {
          cancelAlarm(a)
        })
      }
    }
  } catch (e) {}
}
