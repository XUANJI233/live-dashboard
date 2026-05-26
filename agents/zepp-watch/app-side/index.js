import { log } from '@zos/utils'
import { BaseSideService } from '@zeppos/zml/base-side'

const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000
const MIN_AUTO_INTERVAL_MS = 2 * 60 * 1000
const MAX_AUTO_INTERVAL_MS = 60 * 60 * 1000
const MIN_FORCE_INTERVAL_MS = 30 * 1000
const MAX_RECORDS_PER_SYNC = 10
const DEFAULT_RELAY_MODE = 'phone-side'

function readSetting(settings, key, fallback = '') {
  const value = settings.getItem(key)
  return value == null || value === '' ? fallback : value
}

function trimServerUrl(url) {
  return String(url || '').replace(/\/+$/, '')
}

function asNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

AppSideService(
  BaseSideService({
    state: {
      lastSyncAt: 0,
    },

    onInit() {
      this.state.lastSyncAt = asNumber(readSetting(this.settings, 'lastSyncAt', 0), 0)
      log('Live Dashboard side service init')
    },

    onRequest(req, res) {
      if (req.method !== 'watch.snapshot') {
        res('unsupported method')
        return
      }

      this.handleSnapshot(req.params || {})
        .then((result) => res(null, result))
        .catch((error) => {
          log(`Sync error: ${error}`)
          res(error?.message || 'sync failed')
        })
    },

    async handleSnapshot(snapshot) {
      const now = Date.now()
      const relayMode = readSetting(this.settings, 'relayMode', DEFAULT_RELAY_MODE)
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
      if (typeof snapshot.heart_rate === 'number' && snapshot.heart_rate > 0) {
        records.push({
          type: 'heart_rate',
          value: snapshot.heart_rate,
          unit: 'bpm',
          timestamp: new Date(snapshot.recorded_at || now).toISOString(),
        })
      }

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
