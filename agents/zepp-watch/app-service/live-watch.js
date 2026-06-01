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
import { BloodOxygen } from '@zos/sensor'
import { BodyTemperature } from '@zos/sensor'
import { set as setAlarm, cancel as cancelAlarm, getAllAlarms } from '@zos/alarm'
import { createConnect, send as bleSend, connectStatus } from '@zos/ble'
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
let sleepSkipCounter = 0 // 睡眠状态下跳过传输的计数器
let sensorHeartRate = true
let sensorBattery = true
let sensorStep = true
let sensorSleep = true
let sensorBodyTemp = true
let sensorSpo2 = false

const MAX_HR_RECORDS_PER_SYNC = 30
const MAX_SPO2_RECORDS_PER_SYNC = 12
const MAX_TEMP_RECORDS_PER_SYNC = 24
const MIN_SYNC_INTERVAL_SECONDS = 60
const DEFAULT_SYNC_INTERVAL_SECONDS = 300
const MAX_SYNC_INTERVAL_SECONDS = 900 // server marks Zepp offline after 20 minutes
const MAX_SLEEP_UPLOAD_GAP_MS = 15 * 60_000
const CONFIG_KEY = 'lw_cfg'

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
    console.log('[LiveWatch:device] Failed to persist sleepSkipCounter: ' + e.message)
  }
}

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

function getSleepUploadEveryCycles() {
  return Math.max(1, Math.floor(MAX_SLEEP_UPLOAD_GAP_MS / syncIntervalMs))
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
AppService({
  onInit(options) {
    console.log('[LiveWatch:device] AppService init (single-execution)')

    // Restore sleepSkipCounter from file
    sleepSkipCounter = readSleepSkipCounter()
    console.log('[LiveWatch:device] sleepSkipCounter restored: ' + sleepSkipCounter)

    // Restore lastSpo2SyncTime from file
    lastSpo2SyncTime = readLastSpo2SyncTime()
    lastSpo2SyncDate = readString('lw_spo2_date', '')
    lastHrSyncIndex = readNumber('lw_hr_index', -1)
    lastHrSyncDate = readString('lw_hr_date', '')
    lastTempSyncIndex = readNumber('lw_temp_index', -1)
    lastTempSyncDate = readString('lw_temp_date', '')
    console.log('[LiveWatch:device] lastSpo2SyncTime restored: ' + lastSpo2SyncTime)

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

function applyConfig(cfg) {
  serverUrl = cleanServerUrl(cfg.serverUrl || '')
  token = cleanToken(cfg.token || '')
  syncIntervalMs = clampSyncIntervalSeconds(cfg.syncInterval) * 1000
  enabled = Boolean(cfg.enabled)
  restoreSensorConfig(cfg)
}

// ── Data Collection & Upload (Optimized) ──

function collectAndUpload() {
  const now = new Date()
  const nowISO = now.toISOString()
  const extra = {}

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

  // 2. 智能传输策略：首次检测到睡眠时必须上传（让服务端立即知道），
  //    之后按同步间隔动态跳过，确保服务端不会超过 15 分钟没有状态心跳。
  if (isSleeping) {
    const sleepUploadEveryCycles = getSleepUploadEveryCycles()
    if (sleepSkipCounter === 0) {
      // 首次检测到睡眠 → 强制上传，让服务端立即知道用户睡着了
      sleepSkipCounter = 1
      writeSleepSkipCounter(sleepSkipCounter)
      console.log('[LiveWatch:device] First sleep detected, force upload')
    } else {
      sleepSkipCounter++
      writeSleepSkipCounter(sleepSkipCounter)
      if (sleepSkipCounter < sleepUploadEveryCycles) {
        console.log('[LiveWatch:device] Sleeping, skip all (' + sleepSkipCounter + '/' + sleepUploadEveryCycles + ')')
        return // 直接退出，不获取任何传感器数据
      }
      sleepSkipCounter = 0 // 重置计数器
      writeSleepSkipCounter(sleepSkipCounter)
      console.log('[LiveWatch:device] Sleeping but uploading')
    }
  } else {
    if (sleepSkipCounter !== 0) {
      sleepSkipCounter = 0 // 清醒时重置计数器
      writeSleepSkipCounter(sleepSkipCounter)
      console.log('[LiveWatch:device] sleepSkipCounter reset (awake)')
    }
  }

  // 3. 清醒状态（或睡眠第6次）才获取传感器数据
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
  // Compact format: sends minimal data over BLE/HTTP, side-service expands to verbose
  // s = status, h = HR history [value, minuteIndex], o = SpO2 [value, timeSec], t = temp [value, minuteOffset]

  const unixTs = Math.floor(now.getTime() / 1000)

  const compactStatus = {
    a: 'zw',                       // app_id
    ts: unixTs,                    // timestamp (Unix seconds, no ISO string overhead)
    b: extra.battery_percent ?? 0, // battery
    se: extra.steps ?? 0,          // steps
    st: extra.steps_target ?? 0,   // steps_target
    sp: sensorSleep ? isSleeping : undefined, // sleeping
    hr: extra.heart_rate ?? 0,     // current heart rate
    hrr: extra.heart_rate_resting ?? 0, // resting HR
    d: { p: 'zp' },                // device: { platform: 'zepp' }
  }

  // Compact data arrays (each 85% smaller than verbose)
  const compactHr = sensorHeartRate ? collectHeartRateHistory(now) : []
  const compactSpo2 = sensorSpo2 ? collectSpo2History(6) : []
  const compactTemp = sensorBodyTemp ? collectTempHistory(now) : []

  // Compact payload (short keys for ~84% size reduction)
  const compactPayload = {
    s: compactStatus,
    h: compactHr,   // [[value, minuteIndex], ...]
    o: compactSpo2, // [[value, timeSec], ...]
    t: compactTemp, // [[value, minuteOffset], ...]
  }

  const compactSize = JSON.stringify(compactPayload).length
  console.log('[LiveWatch:device] Compact payload: ' + compactSize + ' bytes')

  // Send compact data to side-service over BLE. Side-service expands and uploads.
  sendToCompanion(compactPayload)
}

function sendToCompanion(payload) {
  // Prefer ZML's request protocol because BaseSideService installs the same
  // protocol listener on the phone side. Raw BLE is only a compatibility
  // fallback when the app-level messaging object is unavailable.
  if (sendToCompanionViaZml(payload)) return
  sendToCompanionRaw(payload)
}

function sendToCompanionViaZml(payload) {
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    const messaging = app && app._options && app._options.globalData && app._options.globalData.messaging
    if (!messaging || typeof messaging.request !== 'function') return false

    messaging.request({
      method: 'BATCH_DATA',
      params: { payload: payload },
    }, { timeout: 15000 }).then(function () {
      console.log('[LiveWatch:device] ZML batch sent')
    }).catch(function (e) {
      console.log('[LiveWatch:device] ZML batch send failed: ' + ((e && e.message) || e))
    })
    console.log('[LiveWatch:device] ZML batch queued')
    return true
  } catch (e) {
    console.log('[LiveWatch:device] ZML messaging unavailable: ' + ((e && e.message) || e))
    return false
  }
}

function sendToCompanionRaw(payload) {
  // @zos/messaging is side-service API; device/app-service side uses @zos/ble.
  try {
    createConnect(function () {})
    const msg = { type: 'batch_data', payload: payload }
    const bytes = utf8Encode(JSON.stringify(msg))
    bleSend(bytes.buffer, bytes.byteLength)
    console.log('[LiveWatch:device] BLE send queued, connected=' + connectStatus() + ', bytes=' + bytes.byteLength)
  } catch (e) {
    console.log('[LiveWatch:device] BLE send failed: ' + ((e && e.message) || e))
  }
}

function cleanServerUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
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
}

function utf8Encode(str) {
  const escaped = encodeURIComponent(str)
  const bytes = []
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped.charAt(i)
    if (ch === '%') {
      bytes.push(parseInt(escaped.substr(i + 1, 2), 16))
      i += 2
    } else {
      bytes.push(ch.charCodeAt(0))
    }
  }
  return new Uint8Array(bytes)
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
      writeNumber('lw_hr_index', lastHrSyncIndex)
      writeString('lw_hr_date', lastHrSyncDate)
    }

    // Collect only non-zero values (compact: [value, minuteIndex])
    // minuteIndex = array index from getToday() (0-1439)
    // Saves ~85% vs verbose {type, value, unit, timestamp}
    const records = []

    for (let i = lastHrSyncIndex + 1; i < todayData.length; i++) {
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

    return records.length > MAX_HR_RECORDS_PER_SYNC
      ? records.slice(records.length - MAX_HR_RECORDS_PER_SYNC)
      : records
  } catch (e) {
    console.log('[LiveWatch:device] getToday() failed: ' + e.message)
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

// ── SpO2 History Collection (getLastFewHour, incremental sync) ──
// getLastDay() 只返回 24 个平均数，不适合详细上报
// getLastFewHour(hour) 返回指定小时内的全部测量数据 {spo2, time}
// 增量同步：只上传 lastSpo2SyncTime 之后的新数据

function collectSpo2History(hours) {
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
      if (d.time <= lastSpo2SyncTime) continue

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

function collectTempHistory(now) {
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

    for (let i = lastTempSyncIndex + 1; i < todayData.length; i++) {
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

    return records.length > MAX_TEMP_RECORDS_PER_SYNC
      ? records.slice(records.length - MAX_TEMP_RECORDS_PER_SYNC)
      : records
  } catch (e) {
    console.log('[LiveWatch:device] bodyTemperature.getToday() failed: ' + e.message)
    return []
  }
}

// ── Expand compact payload to verbose (for server HTTP compatibility) ──
// HR compact: [value, minuteIndex] → {type, value, unit, timestamp}
// SpO2 compact: [value, timeSec] → {type, value, unit, timestamp}
// Temp compact: [value, minuteOffset] → {type, value, unit, timestamp}

function expandToVerbose(compact, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayMs = today.getTime()

  function isoFromMinuteOffset(minuteOffset) {
    return new Date(todayMs + minuteOffset * 60000).toISOString()
  }

  // Expand status: compact → verbose
  const cs = compact.s
  const nowISO = new Date(cs.ts * 1000).toISOString()
  const extraFields = {}
  if (cs.b) extraFields.battery_percent = cs.b
  if (cs.se) extraFields.steps = cs.se
  if (cs.st) extraFields.steps_target = cs.st
  if (cs.sp !== undefined) extraFields.sleeping = cs.sp
  if (cs.hr) extraFields.heart_rate = cs.hr
  if (cs.hrr) extraFields.heart_rate_resting = cs.hrr

  const verboseStatus = {
    app_id: 'zepp_watch',
    window_title: '手表在线',
    timestamp: nowISO,
    extra: {
      ...extraFields,
      device: {
        platform: 'zepp',
        capability_mode: 'normal',
        device_kind: 'watch',
        last_sample_at: nowISO,
      },
    },
  }

  // Expand HR: [value, minuteIndex] → verbose
  const verboseHr = (compact.h || []).map(([v, m]) => ({
    type: 'heart_rate',
    value: v,
    unit: 'bpm',
    timestamp: isoFromMinuteOffset(m),
  }))

  // Expand SpO2: [value, timeSec] → verbose
  const verboseSpo2 = (compact.o || []).map(([v, ts]) => ({
    type: 'oxygen_saturation',
    value: v,
    unit: '%',
    timestamp: new Date(ts * 1000).toISOString(),
  }))

  // Expand Temp: [value, minuteOffset] → verbose
  const verboseTemp = (compact.t || []).map(([v, m]) => ({
    type: 'body_temperature',
    value: v,
    unit: '°C',
    timestamp: isoFromMinuteOffset(m),
  }))

  return {
    status: verboseStatus,
    heart_rate_history: verboseHr,
    spo2_history: verboseSpo2,
    body_temp_history: verboseTemp,
  }
}

// ── Alarm Management (System-level, survives screen-off) ──

function setupNextAlarm() {
  if (!enabled || syncIntervalMs < 60_000) return

  try {
    // Cancel our previous alarms
    const alarms = getAllAlarms()
    if (alarms && alarms.length > 0) {
      alarms.forEach(a => {
        cancelAlarm(a)
      })
    }

    // Setup next alarm (persistent, survives reboot)
    const alarmId = setAlarm({
      url: 'app-service/live-watch',
      delay: Math.ceil(syncIntervalMs / 1000),
      store: true,
    })

    console.log('[LiveWatch:device] Next alarm set, id=' + alarmId + ', delay=' + Math.ceil(syncIntervalMs / 1000) + 's')
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
    })
  } catch (e) {}

  // Cancel all our alarms
  try {
    const alarms = getAllAlarms()
    if (alarms) {
      alarms.forEach(a => {
        cancelAlarm(a)
      })
    }
  } catch (e) {}

  console.log('[LiveWatch:device] Sync stopped')
}
