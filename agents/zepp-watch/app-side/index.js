import { BaseSideService } from '@zeppos/zml/base-side'

const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000
const MIN_AUTO_INTERVAL_MS = 2 * 60 * 1000
const MAX_AUTO_INTERVAL_MS = 60 * 60 * 1000
const MIN_FORCE_INTERVAL_MS = 30 * 1000
const MAX_RECORDS_PER_SYNC = 20
const DEFAULT_RELAY_MODE = 'phone-side'

function readSetting(settings, key, fallback = '') {
  const value = settings.getItem(key)
  return value == null || value === '' ? fallback : value
}

function trimServerUrl(url) {
  return String(url || '').replace(/\/+$/, '')
}

function isAllowedServerUrl(url) {
  const value = trimServerUrl(url)
  const match = value.match(/^(https?):\/\/([^/?#]+)(?:[/?#].*)?$/i)
  if (!match) return false

  const scheme = match[1].toLowerCase()
  const hostPort = match[2].toLowerCase()
  const host = hostPort[0] === '['
    ? hostPort.slice(1, hostPort.indexOf(']'))
    : hostPort.split(':')[0]

  if (scheme === 'https') return host.length > 0
  return scheme === 'http' && (host === 'localhost' || host === '127.0.0.1' || host === '::1')
}

function asNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function enabled(settings, key, fallback = true) {
  const value = settings.getItem(key)
  if (value == null || value === '') return fallback
  return value === '1' || value === true || value === 'true'
}

function addMetricRecord(records, settings, key, type, value, unit, timestamp) {
  if (!enabled(settings, key, true)) return
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  records.push({ type, value, unit, timestamp })
}

AppSideService(
  BaseSideService({
    state: {
      lastSyncAt: 0,
    },

    onInit() {
      this.state.lastSyncAt = asNumber(readSetting(this.settings, 'lastSyncAt', 0), 0)
      this.log('Live Dashboard side service init')
    },

    onSettingsChange({ key, newValue, oldValue }) {
      this.log(`Settings changed: ${key} = ${newValue}`)
    },

    onRequest(req, res) {
      if (req.method !== 'watch.snapshot') {
        res('unsupported method')
        return
      }

      this.handleSnapshot(req.params || {})
        .then((result) => res(null, result))
        .catch((error) => {
          this.log(`Sync error: ${error}`)
          res(error?.message || 'sync failed')
        })
    },

    async handleSnapshot(snapshot) {
      const now = Date.now()
      const relayMode = readSetting(this.settings, 'relayMode', DEFAULT_RELAY_MODE)
      if (snapshot.relay_mode && snapshot.relay_mode !== relayMode) {
        return { ok: false, skipped: true, reason: 'relay_mode_mismatch' }
      }
      if (relayMode !== DEFAULT_RELAY_MODE) {
        return { ok: false, skipped: true, reason: 'unsupported_relay_mode' }
      }

      const configuredInterval = asNumber(
        readSetting(this.settings, 'minIntervalMs', DEFAULT_MIN_INTERVAL_MS),
        DEFAULT_MIN_INTERVAL_MS
      )
      const minInterval = clamp(configuredInterval, MIN_AUTO_INTERVAL_MS, MAX_AUTO_INTERVAL_MS)
      const force = snapshot.force === true
      const elapsed = now - this.state.lastSyncAt
      const effectiveInterval = force ? MIN_FORCE_INTERVAL_MS : minInterval

      if (this.state.lastSyncAt > 0 && elapsed < effectiveInterval) {
        const waitMs = effectiveInterval - elapsed
        return {
          ok: true,
          skipped: true,
          reason: 'rate_limited',
          wait_ms: waitMs,
          next_allowed_at: now + waitMs,
        }
      }

      const serverUrl = trimServerUrl(readSetting(this.settings, 'serverUrl'))
      const token = readSetting(this.settings, 'token')
      if (!serverUrl || !token) {
        return { ok: false, skipped: true, reason: 'missing_config' }
      }
      if (!isAllowedServerUrl(serverUrl)) {
        return { ok: false, skipped: true, reason: 'https_required' }
      }

      await this.postJson(serverUrl, token, '/api/report', {
        app_id: 'zepp_watch',
        window_title: 'zepp_watch',
        timestamp: new Date(now).toISOString(),
        extra: {
          device: {
            capability_mode: 'normal',
            relay_mode: relayMode,
            energy_policy: 'balanced',
            min_interval_ms: minInterval,
            last_sample_at: new Date(now).toISOString(),
          },
        },
      })

      const records = []
      const recordedAt = new Date(snapshot.recorded_at || now).toISOString()
      const metrics = snapshot.watch_metrics && typeof snapshot.watch_metrics === 'object'
        ? snapshot.watch_metrics
        : {}

      addMetricRecord(records, this.settings, 'sensorHeartRate', 'heart_rate', metrics.heart_rate || snapshot.heart_rate, 'bpm', recordedAt)
      addMetricRecord(records, this.settings, 'sensorBattery', 'battery_percent', metrics.battery_percent, '%', recordedAt)
      addMetricRecord(records, this.settings, 'sensorWear', 'wear_status', metrics.wear_status, 'status', recordedAt)
      addMetricRecord(records, this.settings, 'sensorSleep', 'sleep_status', metrics.sleep_status, 'status', recordedAt)
      addMetricRecord(records, this.settings, 'sensorSpo2', 'oxygen_saturation', metrics.spo2, '%', recordedAt)
      addMetricRecord(records, this.settings, 'sensorBodyTemp', 'body_temperature', metrics.body_temperature, 'celsius', recordedAt)
      addMetricRecord(records, this.settings, 'sensorStand', 'stand_hours', metrics.stand_hours, 'hours', recordedAt)
      addMetricRecord(records, this.settings, 'sensorStress', 'stress', metrics.stress, 'score', recordedAt)
      addMetricRecord(records, this.settings, 'sensorStep', 'steps', metrics.steps, 'count', recordedAt)
      addMetricRecord(records, this.settings, 'sensorCalorie', 'active_calories', metrics.calorie, 'kcal', recordedAt)
      addMetricRecord(records, this.settings, 'sensorBarometer', 'air_pressure', metrics.air_pressure, 'hPa', recordedAt)
      addMetricRecord(records, this.settings, 'sensorBarometer', 'altitude', metrics.altitude, 'm', recordedAt)

      if (records.length > 0) {
        await this.postJson(serverUrl, token, '/api/health-data', {
          records: records.slice(0, MAX_RECORDS_PER_SYNC),
        })
      }

      this.state.lastSyncAt = now
      this.settings.setItem('lastSyncAt', String(now))
      return { ok: true, uploaded_records: records.length }
    },

    postJson(serverUrl, token, path, body) {
      return this.fetch({
        method: 'POST',
        url: `${serverUrl}${path}`,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }).then((result) => {
        if (result.status < 200 || result.status >= 300) {
          throw new Error(`HTTP ${result.status}`)
        }
        return result
      })
    },
  })
)
