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
let lastHrSyncIndex = -1 // tracks last synced minute-index in heartRate.getToday()
let lastHrSyncDate = '' // YYYY-MM-DD to detect day change and reset index

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
    // Only release runtime resources — do NOT change the user's enabled config.
    // System may kill/restart the service at any time.
    stopRuntime()
  },
})

// ── Config (from settingsStorage, standard Zepp API) ──

function restoreConfig() {
  try {
    // Primary: settingsStorage (synced with companion)
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
    // Fallback: file-based config (settingsStorage may not be available in device context)
    try {
      const fs = require('@zos/fs')
      const data = fs.readFileSync('data://livewatch_config.json')
      if (data) {
        const cfg = JSON.parse(data)
        serverUrl = cfg.serverUrl || ''
        token = cfg.token || ''
        syncIntervalMs = Math.max(60_000, (cfg.syncInterval || 300) * 1000)
        enabled = cfg.enabled || false
        console.log('[LiveWatch:device] Config restored from file: enabled=' + enabled)
      }
    } catch (e2) {
      console.log('[LiveWatch:device] No saved config (settingsStorage + file both unavailable)')
    }
  }
}

function persistConfig() {
  const cfg = JSON.stringify({
    serverUrl, token,
    syncInterval: Math.round(syncIntervalMs / 1000),
    enabled,
  })
  try {
    // Primary: sync via settingsStorage (companion-visible)
    const storage = require('@zos/settings').settingsStorage
    storage.setItem('livewatch_config', cfg)
  } catch (e) { /* settingsStorage may be unavailable in device context */ }
  try {
    // Fallback: local file (always available on device)
    const fs = require('@zos/fs')
    fs.writeFileSync('data://livewatch_config.json', cfg)
  } catch (e) { /* file system may be unavailable in preview */ }
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
  // Called only by explicit user action (page STOP button or companion relay).
  // This sets enabled=false AND stops runtime resources.
  enabled = false
  persistConfig()
  stopRuntime()
  console.log('[LiveWatch:device] Sync disabled by user')
}

function stopRuntime() {
  // Release timer/alarm resources without changing the user's enabled flag.
  // Called by onDestroy() (system may restart us) and stopSync().
  if (syncTimerId != null) {
    stopTimer(syncTimerId)
    syncTimerId = null
  }
  if (alarmId != null) {
    cancelAlarm(alarmId)
    alarmId = null
  }
}

function setupAlarm() {
  if (syncIntervalMs < 60_000) return
  try {
    // Only cancel OUR app-service alarm — don't touch other app alarms
    const alarms = getAllAlarms()
    if (alarms && alarms.length > 0) {
      alarms.forEach(a => {
        if (a.url === 'app-service/live-watch.js') cancelAlarm(a.id)
      })
    }
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

  // httpRequest is provided by zml messaging plugin for device-side HTTP.
  // If unavailable in the device context, cache data locally for later upload.
  // In zeus preview, httpRequest should work if the simulator network is active.
  if (typeof httpRequest !== 'function') {
    console.warn('[LiveWatch:device] httpRequest not available — caching data locally')
    cacheDataForLaterUpload(body)
    return
  }
  
  // Try to upload any previously cached data first
  uploadCachedData()
  
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
      // Upload historical heart rate data after successful status sync
      uploadHeartRateHistory()
    } else {
      console.warn('[LiveWatch:device] HTTP ' + res.status)
    }
  }).catch(err => {
    console.error('[LiveWatch:device] Sync failed: ' + (err.message || err))
  })
}

// ── Local Data Cache ──────────

const CACHE_FILE = 'data://live_watch_cache.json'
const MAX_CACHE_ENTRIES = 100 // Prevent unbounded growth

function cacheDataForLaterUpload(body) {
  try {
    const fs = require('@zos/fs')
    let cache = []
    
    // Read existing cache
    try {
      const existing = fs.readFileSync(CACHE_FILE)
      if (existing) {
        cache = JSON.parse(existing)
        if (!Array.isArray(cache)) cache = []
      }
    } catch (e) { /* File doesn't exist or is invalid */ }
    
    // Add new entry with timestamp
    cache.push({
      timestamp: Date.now(),
      body: body,
    })
    
    // Limit cache size (keep most recent entries)
    if (cache.length > MAX_CACHE_ENTRIES) {
      cache = cache.slice(-MAX_CACHE_ENTRIES)
    }
    
    // Write back to file
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache))
    console.log('[LiveWatch:device] Cached data for later upload (total: ' + cache.length + ')')
  } catch (e) {
    console.warn('[LiveWatch:device] Failed to cache data: ' + e.message)
  }
}

function uploadCachedData() {
  try {
    const fs = require('@zos/fs')
    let cache = []
    
    try {
      const existing = fs.readFileSync(CACHE_FILE)
      if (existing) {
        cache = JSON.parse(existing)
        if (!Array.isArray(cache) || cache.length === 0) return
      } else {
        return // No cache file
      }
    } catch (e) {
      return // No cache or invalid
    }
    
    console.log('[LiveWatch:device] Uploading ' + cache.length + ' cached entries')
    
    // Upload each cached entry
    let successCount = 0
    for (const entry of cache) {
      try {
        const res = httpRequest({
          method: 'POST',
          url: serverUrl.replace(/\/+$/, '') + '/api/report',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
          },
          body: entry.body,
          timeout: 10_000,
        })
        
        if (res.status >= 200 && res.status < 300) {
          successCount++
        } else {
          console.warn('[LiveWatch:device] Cached upload HTTP ' + res.status)
          break // Stop on first failure
        }
      } catch (err) {
        console.error('[LiveWatch:device] Cached upload failed: ' + (err.message || err))
        break // Stop on first failure
      }
    }
    
    if (successCount > 0) {
      console.log('[LiveWatch:device] Uploaded ' + successCount + ' cached entries')
      // Remove successfully uploaded entries
      cache = cache.slice(successCount)
      if (cache.length === 0) {
        // Delete cache file if empty
        try { fs.unlinkSync(CACHE_FILE) } catch (e) { /* ignore */ }
      } else {
        // Write remaining entries back
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache))
      }
    }
  } catch (e) {
    console.warn('[LiveWatch:device] Failed to upload cached data: ' + e.message)
  }
}

// ── Historical Heart Rate Upload ──────────

function uploadHeartRateHistory() {
  try {
    const todayData = heartRate.getToday()
    if (!todayData || todayData.length === 0) return

    // Reset sync index on day change
    const now = new Date()
    const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
    if (todayStr !== lastHrSyncDate) {
      lastHrSyncIndex = -1
      lastHrSyncDate = todayStr
    }

    // Only upload new entries since last sync
    const newEntries = []
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    // Smooth zero values: interpolate between valid readings
    for (let i = lastHrSyncIndex + 1; i < todayData.length; i++) {
      const hr = todayData[i]
      const timestamp = new Date(today.getTime() + i * 60000).toISOString()
      
      let value = hr
      if (hr === 0) {
        // Find previous valid value
        let prevVal = 0, prevIdx = i - 1
        while (prevIdx > lastHrSyncIndex && todayData[prevIdx] === 0) prevIdx--
        if (prevIdx > lastHrSyncIndex) prevVal = todayData[prevIdx]
        
        // Find next valid value
        let nextVal = 0, nextIdx = i + 1
        while (nextIdx < todayData.length && todayData[nextIdx] === 0) nextIdx++
        if (nextIdx < todayData.length) nextVal = todayData[nextIdx]
        
        // Linear interpolation if both sides have valid values
        if (prevVal > 0 && nextVal > 0) {
          const ratio = (i - prevIdx) / (nextIdx - prevIdx)
          value = Math.round(prevVal + ratio * (nextVal - prevVal))
        } else if (prevVal > 0) {
          value = prevVal // Use previous value if no next value
        } else if (nextVal > 0) {
          value = nextVal // Use next value if no previous value
        } else {
          continue // Skip if no valid values anywhere (entire array is zeros)
        }
      }
      
      newEntries.push({
        type: 'heart_rate',
        value: value,
        unit: 'bpm',
        timestamp: timestamp,
      })
    }

    if (newEntries.length === 0) return

    const body = JSON.stringify({ records: newEntries })

    httpRequest({
      method: 'POST',
      url: serverUrl.replace(/\/+$/, '') + '/api/health-data',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: body,
      timeout: 15_000,
    }).then(res => {
      if (res.status >= 200 && res.status < 300) {
        lastHrSyncIndex = todayData.length - 1
        console.log('[LiveWatch:device] HR history OK: ' + newEntries.length + ' records')
      } else {
        console.warn('[LiveWatch:device] HR history HTTP ' + res.status)
      }
    }).catch(err => {
      console.error('[LiveWatch:device] HR history failed: ' + (err.message || err))
    })
  } catch (e) {
    console.warn('[LiveWatch:device] getToday() unavailable: ' + e.message)
  }
}