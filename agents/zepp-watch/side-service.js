import { BaseSideService } from '@zeppos/zml/base-side'
import { createSysTimer, stopTimer } from '@zos/timer'
import { set as setAlarm, cancel as cancelAlarm, getAllAlarms } from '@zos/alarm'

// ────────────────────────────────────────────
//  Live Watch — Background Sync Side Service
//
//  Uses createSysTimer (system-level, survives
//  screen-off) to periodically collect watch
//  health data and send it to the Live Dashboard
//  server via httpRequest.
//
//  Alarm API provides persistent wake-up as a
//  fallback for long-running sync.
// ────────────────────────────────────────────

const DEFAULT_SERVER_URL = ''
const DEFAULT_SYNC_INTERVAL_MS = 30_000 // 30 seconds
const ALARM_URL = 'side-service.js'

AppSideService(
  BaseSideService({
    // Configuration (synced from page.js via SettingsPlugin)
    state: {
      serverUrl: DEFAULT_SERVER_URL,
      token: '',
      syncIntervalMs: DEFAULT_SYNC_INTERVAL_MS,
      enabled: false,
    },

    // Runtime state
    _timerId: null,
    _alarmId: null,
    _lastSyncAt: 0,

    // ── Lifecycle ──────────────────────────

    onInit() {
      console.log('[LiveWatch:side] Side service initializing')
      this.restoreConfig()
    },

    onRun() {
      console.log('[LiveWatch:side] Side service running')
      // Auto-start if previously enabled
      if (this.state.enabled) {
        this.startPeriodicSync()
      }
    },

    onDestroy() {
      console.log('[LiveWatch:side] Side service destroying')
      this.stopPeriodicSync()
    },

    // ── Request handlers (called from page.js) ──

    onRequest(req, res) {
      const { method, params } = req
      console.log('[LiveWatch:side] onRequest: ' + method)

      switch (method) {
        case 'startSync':
          this.state.enabled = true
          this.state.serverUrl = params?.serverUrl || this.state.serverUrl
          this.state.token = params?.token || this.state.token
          this.state.syncIntervalMs = (params?.syncInterval || 30) * 1000
          this.persistConfig()
          this.startPeriodicSync()
          res(null, { ok: true })
          break

        case 'stopSync':
          this.state.enabled = false
          this.persistConfig()
          this.stopPeriodicSync()
          res(null, { ok: true })
          break

        case 'updateConfig':
          if (params?.serverUrl !== undefined) this.state.serverUrl = params.serverUrl
          if (params?.token !== undefined) this.state.token = params.token
          if (params?.syncInterval !== undefined) {
            this.state.syncIntervalMs = params.syncInterval * 1000
          }
          this.persistConfig()
          if (this.state.enabled) {
            // Restart with new interval
            this.stopPeriodicSync()
            this.startPeriodicSync()
          }
          res(null, { ok: true })
          break

        case 'getStatus':
          res(null, {
            enabled: this.state.enabled,
            lastSyncAt: this._lastSyncAt > 0
              ? new Date(this._lastSyncAt).toISOString()
              : null,
            serverUrl: this.state.serverUrl,
          })
          break

        default:
          res({ error: 'unknown method: ' + method }, null)
      }
    },

    // ── Periodic Sync ──────────────────────

    startPeriodicSync() {
      if (this._timerId != null) return // already running

      const interval = Math.max(5_000, this.state.syncIntervalMs || DEFAULT_SYNC_INTERVAL_MS)
      console.log('[LiveWatch:side] Starting periodic sync every ' + interval + 'ms')

      // createSysTimer runs at system level — NOT affected by screen-off
      // See: https://docs.zepp.com/zh-cn/docs/reference/device-app-api/newAPI/timer/createSysTimer/
      this._timerId = createSysTimer(true, interval, () => {
        this.syncNow()
      })

      // Also set a persistent alarm for resilience (survives reboot)
      this.setupFallbackAlarm(interval)
    },

    stopPeriodicSync() {
      if (this._timerId != null) {
        stopTimer(this._timerId)
        this._timerId = null
        console.log('[LiveWatch:side] Periodic sync stopped')
      }
      if (this._alarmId != null) {
        cancelAlarm(this._alarmId)
        this._alarmId = null
      }
    },

    setupFallbackAlarm(intervalMs) {
      // Only use alarm if interval > 60s (alarms have minimum granularity)
      if (intervalMs < 60_000) return
      try {
        // Clean up old alarms
        const alarms = getAllAlarms()
        if (alarms && alarms.length > 0) {
          alarms.forEach((a) => cancelAlarm(a.id))
        }
        // Set repeating alarm
        this._alarmId = setAlarm({
          url: ALARM_URL,
          delay: Math.ceil(intervalMs / 1000),
          repeat_type: 1, // REPEAT_MINUTE equivalent — actually use delay-based single shot
          store: true,     // persist across reboot
        })
        console.log('[LiveWatch:side] Fallback alarm set, id=' + this._alarmId)
      } catch (e) {
        console.warn('[LiveWatch:side] Alarm setup failed: ' + e.message)
      }
    },

    // ── Data Collection & Upload ───────────

    syncNow() {
      const url = this.state.serverUrl
      const token = this.state.token
      if (!url || !token) {
        console.log('[LiveWatch:side] Sync skipped: no server URL or token configured')
        return
      }

      // Collect watch data
      const payload = this.collectWatchData()
      this._lastSyncAt = Date.now()

      // POST to /api/report (same endpoint as Android client)
      this.httpRequest({
        method: 'POST',
        url: url.replace(/\/+$/, '') + '/api/report',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify(payload),
        timeout: 10_000,
      })
        .then((res) => {
          if (res.status >= 200 && res.status < 300) {
            console.log('[LiveWatch:side] Sync OK: ' + payload.app_id)
          } else {
            console.warn('[LiveWatch:side] Sync HTTP ' + res.status)
          }
        })
        .catch((err) => {
          console.error('[LiveWatch:side] Sync failed: ' + (err.message || err))
        })
    },

    collectWatchData() {
      // Collect available watch data through Zepp OS sensor APIs.
      // Actual data depends on watch model and permissions.
      const now = new Date().toISOString()
      const extra = {}

      // Try to read battery level (available on most models)
      try {
        const battery = this.getBatteryInfo()
        if (battery) {
          extra.battery_percent = battery.level
          extra.battery_charging = battery.charging
        }
      } catch (e) { /* sensor unavailable */ }

      // Try to read step count (requires health permission)
      try {
        const steps = this.getStepCount()
        if (steps != null) extra.steps = steps
      } catch (e) { /* sensor unavailable */ }

      // Try to read heart rate (requires health permission)
      try {
        const hr = this.getHeartRate()
        if (hr != null) extra.heart_rate = hr
      } catch (e) { /* sensor unavailable */ }

      return {
        app_id: 'zepp-watch',
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
      }
    },

    // ── Watch Sensor Helpers ───────────────

    getBatteryInfo() {
      try {
        // Zepp OS Battery API (available since API_LEVEL 2.0)
        const battery = hmBle.getBatteryInfo?.()
        if (battery) {
          return { level: battery.level || 0, charging: battery.charging || false }
        }
      } catch (e) { /* not available */ }
      return null
    },

    getStepCount() {
      try {
        // Zepp OS Sensor API
        const sensor = hmSensor.createSensor(hmSensor.id.STEP)
        if (sensor) return sensor.current || 0
      } catch (e) { /* not available */ }
      return null
    },

    getHeartRate() {
      try {
        const sensor = hmSensor.createSensor(hmSensor.id.HEART)
        if (sensor) return sensor.last || 0
      } catch (e) { /* not available */ }
      return null
    },

    // ── Config Persistence ─────────────────

    restoreConfig() {
      try {
        // SettingsPlugin stores settings to device flash via zml
        this.getSettings().then((saved) => {
          if (saved.serverUrl) this.state.serverUrl = saved.serverUrl
          if (saved.token) this.state.token = saved.token
          if (saved.syncIntervalMs) this.state.syncIntervalMs = Number(saved.syncIntervalMs)
          if (saved.enabled !== undefined) this.state.enabled = Boolean(saved.enabled)
          console.log('[LiveWatch:side] Config restored: enabled=' + this.state.enabled)
        }).catch(() => {
          console.log('[LiveWatch:side] No saved config found')
        })
      } catch (e) {
        console.warn('[LiveWatch:side] restoreConfig failed: ' + e.message)
      }
    },

    persistConfig() {
      try {
        this.setSettings({
          serverUrl: this.state.serverUrl,
          token: this.state.token,
          syncIntervalMs: this.state.syncIntervalMs,
          enabled: this.state.enabled,
        })
      } catch (e) {
        console.warn('[LiveWatch:side] persistConfig failed: ' + e.message)
      }
    },

    getSettings() {
      // Provided by @zeppos/zml SettingsPlugin
      if (typeof this._getSettings === 'function') {
        return this._getSettings()
      }
      return Promise.resolve({})
    },

    setSettings(settings) {
      if (typeof this._setSettings === 'function') {
        this._setSettings(settings)
      }
    },
  }),
)