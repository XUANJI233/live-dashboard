// ────────────────────────────────────────────
//  Live Watch — Companion Side Service (v2 - Enhanced)
//  运行在手机 Zepp 伴生侧，负责：
//  1. 配置持久化 (settings.settingsStorage)
//  2. 页面请求处理
//  3. 接收手表端原始数据 (BLE)
//  4. O(N) 心率插值 (手机端有充足电量)
//  5. 上传到服务器 (HTTP)
//
//  硬件工程师思维：手表端只做采集，复杂计算交给手机端
// ────────────────────────────────────────────

import { BaseSideService } from '@zeppos/zml/base-side'

const MIN_SYNC_INTERVAL_SECONDS = 60
const DEFAULT_SYNC_INTERVAL_SECONDS = 300
const MAX_SYNC_INTERVAL_SECONDS = 900
const PENDING_STATUS_KEY = 'livewatch_pending_status'
const PENDING_HEALTH_KEY = 'livewatch_pending_health'
const MAX_PENDING_HEALTH_RECORDS = 5000
const HEALTH_UPLOAD_CHUNK_SIZE = 1000
const SENSOR_KEYS = [
  'sensorHeartRate',
  'sensorBattery',
  'sensorStep',
  'sensorSleep',
  'sensorBodyTemp',
  'sensorSpo2',
  'sensorStress',
]

function cleanToken(value) {
  return String(value || '').replace(/^Bearer\s+/i, '').trim()
}

function cleanServerUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/(?:report|health-data)$/i, '')
    .replace(/\/api$/i, '')
}

function clampSyncIntervalSeconds(value) {
  const numeric = Number(value)
  const seconds = Number.isFinite(numeric) ? numeric : DEFAULT_SYNC_INTERVAL_SECONDS
  return Math.max(MIN_SYNC_INTERVAL_SECONDS, Math.min(MAX_SYNC_INTERVAL_SECONDS, seconds))
}

function shouldRetryStatus(status) {
  return status === 429 || status >= 500
}

function chunkRecords(records, size) {
  const out = []
  for (let i = 0; i < records.length; i += size) {
    out.push(records.slice(i, i + size))
  }
  return out
}

function concatChunks(chunks, startIndex) {
  const out = []
  for (let i = startIndex; i < chunks.length; i++) {
    for (let j = 0; j < chunks[i].length; j++) out.push(chunks[i][j])
  }
  return out
}

AppSideService(
  BaseSideService({
    state: {
      serverUrl: '',
      token: '',
      syncInterval: 300,
      enabled: false,
      sensorHeartRate: true,
      sensorBattery: true,
      sensorStep: true,
      sensorSleep: true,
      sensorBodyTemp: true,
      sensorSpo2: false,
      sensorStress: false,
    },

    onInit() {
      console.log('[COMPANION] init')
      this.restoreConfig()
    },

    onRun() {
      console.log('[LiveWatch:companion] running')
    },

    onDestroy() {
      console.log('[LiveWatch:companion] destroy')
    },

    onRequest(req, res) {
      var method = req.method
      var params = req.params || {}
      console.log('[COMPANION] onRequest method=' + method)
      switch (method) {
        case 'GET_CONFIG': {
          res(null, {
            serverUrl: this.state.serverUrl || '',
            token: this.state.token || '',
            syncInterval: this.state.syncInterval || 300,
            enabled: this.state.enabled || false,
            sensorHeartRate: this.state.sensorHeartRate,
            sensorBattery: this.state.sensorBattery,
            sensorStep: this.state.sensorStep,
            sensorSleep: this.state.sensorSleep,
            sensorBodyTemp: this.state.sensorBodyTemp,
            sensorSpo2: this.state.sensorSpo2,
            sensorStress: this.state.sensorStress,
          })
          break
        }
        case 'START': {
          this.state.serverUrl = cleanServerUrl((params && params.serverUrl) || this.state.serverUrl)
          this.state.token = cleanToken((params && params.token) || this.state.token)
          this.state.syncInterval = clampSyncIntervalSeconds((params && params.syncInterval) || this.state.syncInterval)
          this.state.enabled = true
          this.persistConfig()
          res(null, { ok: true, status: 'started' })
          break
        }
        case 'STOP': {
          this.state.enabled = false
          this.persistConfig()
          res(null, { ok: true, status: 'stopped' })
          break
        }
        case 'UPLOAD_NOW': {
          var url = (params && params.serverUrl) || this.state.serverUrl
          var tok = (params && params.token) || this.state.token
          if (!url || !tok) { res(null, { ok: false, reason: 'no config' }); break }
          this.state.serverUrl = cleanServerUrl(url)
          this.state.token = cleanToken(tok)
          this.persistConfig()
          this.flushPendingUploads(true)
          res(null, { ok: true, status: 'watch_full_upload_queued' })
          break
        }
        case 'BATCH_DATA': {
          this.handleBatchData((params && params.payload) || params, res)
          break
        }
        default:
          console.log('[COMPANION] unknown method: ' + method)
          res({ error: 'unknown method' }, null)
      }
    },

    onCall(req) {
      var method = req && req.method
      var params = (req && req.params) || {}
      if (method === 'BATCH_DATA') {
        this.handleBatchData((params && params.payload) || params)
      }
    },

    // ── 设置变更实时同步（来自设置应用） ──
    onSettingsChange({ key, newValue }) {
      if (key === 'livewatch_config' && newValue) {
        try {
          const cfg = JSON.parse(newValue)
          if (cfg.serverUrl !== undefined) this.state.serverUrl = cleanServerUrl(cfg.serverUrl)
          if (cfg.token !== undefined) this.state.token = cleanToken(cfg.token)
          if (cfg.syncInterval !== undefined) this.state.syncInterval = clampSyncIntervalSeconds(cfg.syncInterval)
          SENSOR_KEYS.forEach((key) => {
            if (cfg[key] !== undefined) this.state[key] = Boolean(cfg[key])
          })
          if (cfg.enabled !== undefined) {
            this.state.enabled = Boolean(cfg.enabled)
            console.log('[LiveWatch:companion] Settings changed, enabled=' + this.state.enabled)
          }
          this.persistConfig()
        } catch (e) {
          console.warn('[LiveWatch:companion] Failed to parse settings change: ' + e.message)
        }
      }
    },

    // ── 处理手表端批量数据 ──

    handleBatchData(params, res) {
      if (!params || !this.state.serverUrl || !this.state.token) {
        if (res) res({ error: 'invalid params or config' }, null)
        return
      }

      const payloads = Array.isArray(params.payloads) ? params.payloads : [params]
      let accepted = 0
      for (const payload of payloads) {
        if (this.handleSingleBatchData(payload)) accepted += 1
      }

      if (res) {
        res(null, accepted > 0
          ? { ok: true, message: 'processing', batches: accepted }
          : { ok: false, reason: 'invalid compact payload' })
      }
    },

    handleSingleBatchData(params) {
      // Compact payload is the BLE format. Verbose payload is accepted for
      // compatibility with older manual/debug senders.
      const expanded = params.status ? params : this.expandCompact(params)
      if (!expanded) {
        return false
      }

      const { status, heart_rate_history, spo2_history, body_temp_history, sleep_history } = expanded
      const forceUpload = Boolean(expanded.manual)
      const healthRecords = this.statusToHealthRecords(status)

      this.flushPendingUploads(forceUpload)

      // 1. Status report
      if (status) {
        this.uploadStatus(status, { force: forceUpload })
      }

      // 2. Interpolate + upload HR history (phone has power for this)
      if (heart_rate_history && heart_rate_history.length > 0) {
        const interpolated = this.interpolateHeartRate(heart_rate_history)
        if (interpolated.length > 0) {
          healthRecords.push(...interpolated)
        }
      }

      // 3. Upload SpO2 history (no interpolation needed)
      if (spo2_history && spo2_history.length > 0) {
        healthRecords.push(...spo2_history)
      }

      // 4. Upload body temp history (no interpolation needed)
      if (body_temp_history && body_temp_history.length > 0) {
        healthRecords.push(...body_temp_history)
      }

      if (sleep_history && sleep_history.length > 0) {
        healthRecords.push(...sleep_history)
      }

      if (healthRecords.length > 0) {
        this.uploadHealthRecords(healthRecords, { force: forceUpload })
      }

      return true
    },

    flushPendingUploads(force) {
      if ((!this.state.enabled && !force) || !this.state.serverUrl || !this.state.token) return
      this.flushPendingStatus(force)
      this.flushPendingHealthRecords(force)
    },

    flushPendingStatus(force) {
      try {
        const raw = settings.settingsStorage.getItem(PENDING_STATUS_KEY)
        if (!raw) return
        const status = JSON.parse(raw)
        this.uploadStatus(status, { pending: true, force: force })
      } catch (e) {
        settings.settingsStorage.removeItem(PENDING_STATUS_KEY)
      }
    },

    flushPendingHealthRecords(force) {
      const records = this.readPendingHealthRecords()
      if (records.length > 0) {
        this.uploadHealthRecords(records, { pending: true, force: force })
      }
    },

    queuePendingStatus(status) {
      try {
        settings.settingsStorage.setItem(PENDING_STATUS_KEY, JSON.stringify(status))
      } catch (e) {
        console.warn('[LiveWatch:companion] Failed to queue pending status: ' + ((e && e.message) || e))
      }
    },

    readPendingHealthRecords() {
      try {
        const raw = settings.settingsStorage.getItem(PENDING_HEALTH_KEY)
        const records = raw ? JSON.parse(raw) : []
        return Array.isArray(records) ? records : []
      } catch (e) {
        return []
      }
    },

    queuePendingHealthRecords(records) {
      try {
        const pending = this.readPendingHealthRecords()
        const merged = pending.concat(records).slice(-MAX_PENDING_HEALTH_RECORDS)
        settings.settingsStorage.setItem(PENDING_HEALTH_KEY, JSON.stringify(merged))
      } catch (e) {
        console.warn('[LiveWatch:companion] Failed to queue pending health records: ' + ((e && e.message) || e))
      }
    },

    statusToHealthRecords(status) {
      if (!status || !status.extra) return []
      const ts = status.timestamp || new Date().toISOString()
      const out = []
      if (typeof status.extra.heart_rate === 'number' && status.extra.heart_rate > 0) {
        out.push({ type: 'heart_rate', value: status.extra.heart_rate, unit: 'bpm', timestamp: ts })
      }
      if (typeof status.extra.heart_rate_resting === 'number' && status.extra.heart_rate_resting > 0) {
        out.push({ type: 'resting_heart_rate', value: status.extra.heart_rate_resting, unit: 'bpm', timestamp: ts })
      }
      if (typeof status.extra.steps === 'number' && status.extra.steps >= 0) {
        out.push({ type: 'steps', value: status.extra.steps, unit: 'count', timestamp: ts })
      }
      if (typeof status.extra.battery_percent === 'number' && status.extra.battery_percent >= 0) {
        out.push({ type: 'battery_percent', value: status.extra.battery_percent, unit: '%', timestamp: ts })
      }
      if (typeof status.extra.sleeping === 'boolean') {
        out.push({ type: 'sleep_status', value: status.extra.sleeping ? 1 : 0, unit: 'state', timestamp: ts })
      }
      return out
    },

    // ── Expand compact format to verbose ──
    // Compacts ~84% payload for BLE transfer, expand here for server upload

    expandCompact(compact) {
      try {
        const cs = compact.s
        if (!cs || !cs.ts) return null

        // Determine date from timestamp
        const baseDate = new Date(cs.ts * 1000)
        const today = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate())
        const todayMs = today.getTime()
        const nowISO = baseDate.toISOString()

        // Build verbose status
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

        // HR: [value, minuteIndex] → verbose
        const verboseHr = (compact.h || []).map(([v, m]) => ({
          type: 'heart_rate',
          value: v,
          unit: 'bpm',
          timestamp: new Date(todayMs + m * 60000).toISOString(),
        }))

        // SpO2: [value, timeSec] → verbose
        const verboseSpo2 = (compact.o || []).map(([v, ts]) => ({
          type: 'oxygen_saturation',
          value: v,
          unit: '%',
          timestamp: new Date(ts * 1000).toISOString(),
        }))

        // Temp: [value, minuteOffset] → verbose
        const verboseTemp = (compact.t || []).map(([v, m]) => ({
          type: 'body_temperature',
          value: v,
          unit: 'celsius',
          timestamp: new Date(todayMs + m * 60000).toISOString(),
        }))
        const verboseSleep = this.expandSleepDetails(compact.sl, todayMs, nowISO)

        return {
          status: verboseStatus,
          heart_rate_history: verboseHr,
          spo2_history: verboseSpo2,
          body_temp_history: verboseTemp,
          sleep_history: verboseSleep,
          manual: compact.m === 1,
        }
      } catch (e) {
        console.error('[LiveWatch:companion] expandCompact failed: ' + e.message)
        return null
      }
    },

    expandSleepDetails(details, todayMs, nowISO) {
      if (!details || typeof details !== 'object') return []
      const out = []

      function validMinute(value) {
        return Number.isFinite(value) && value >= 0 && value < 1440
      }

      function minuteIso(value) {
        return new Date(todayMs + value * 60000).toISOString()
      }

      if (validMinute(details.st)) out.push({ type: 'sleep_start', value: details.st, unit: 'minute_of_day', timestamp: nowISO })
      if (validMinute(details.en)) out.push({ type: 'sleep_end', value: details.en, unit: 'minute_of_day', timestamp: nowISO })
      if (Number.isFinite(details.du) && details.du > 0) out.push({ type: 'sleep_duration', value: details.du, unit: 'minutes', timestamp: nowISO })
      if (Number.isFinite(details.de) && details.de >= 0) out.push({ type: 'deep_sleep_duration', value: details.de, unit: 'minutes', timestamp: nowISO })
      if (Number.isFinite(details.sc) && details.sc >= 0) out.push({ type: 'sleep_score', value: details.sc, unit: 'score', timestamp: nowISO })
      if (Number.isFinite(details.sg) && details.sg >= 0) out.push({ type: 'sleep_stage_count', value: details.sg, unit: 'count', timestamp: nowISO })

      if (Array.isArray(details.np)) {
        details.np.forEach((nap) => {
          if (!Array.isArray(nap) || nap.length < 3) return
          const start = nap[0]
          const end = nap[1]
          const duration = nap[2]
          if (validMinute(start)) out.push({ type: 'nap_start', value: start, unit: 'minute_of_day', timestamp: minuteIso(start) })
          if (validMinute(end)) out.push({ type: 'nap_end', value: end, unit: 'minute_of_day', timestamp: minuteIso(end) })
          if (Number.isFinite(duration) && duration > 0) out.push({ type: 'nap_duration', value: duration, unit: 'minutes', timestamp: validMinute(start) ? minuteIso(start) : nowISO })
        })
      }

      return out
    },

    // ── O(N) 心率插值算法 ──
    // 输入：非零心率数据点（稀疏）
    // 输出：每分钟一个数据点（连续，含插值）

    interpolateHeartRate(records) {
      if (!records || records.length === 0) return []

      // 1. 按时间排序并合并同一分钟的重复读数
      const sorted = records.slice().sort((a, b) => {
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      }).filter((record) => Number.isFinite(new Date(record.timestamp).getTime()) && Number.isFinite(record.value))
      if (sorted.length === 0) return []

      const points = []
      for (let i = 0; i < sorted.length; i++) {
        const minuteTs = Math.floor(new Date(sorted[i].timestamp).getTime() / 60000) * 60000
        const value = sorted[i].value
        const prev = points[points.length - 1]
        if (prev && prev.ts === minuteTs) {
          prev.value = value
        } else {
          points.push({ ts: minuteTs, value: value })
        }
      }
      if (points.length === 0) return []

      // 2. 确定时间范围（从第一个到最后一个）
      const firstTs = new Date(sorted[0].timestamp).getTime()
      const lastTs = new Date(sorted[sorted.length - 1].timestamp).getTime()

      // 3. 按分钟填充，使用双指针线性插值，避免 O(N²)
      const result = []
      let nextIndex = 0

      for (let ts = Math.floor(firstTs / 60000) * 60000; ts <= lastTs; ts += 60000) {
        while (nextIndex < points.length && points[nextIndex].ts < ts) nextIndex++
        const next = points[nextIndex] || null
        const prev = next && next.ts === ts ? next : points[nextIndex - 1] || null
        let value

        if (next && next.ts === ts) {
          value = next.value
        } else if (prev && next) {
          const ratio = (ts - prev.ts) / (next.ts - prev.ts)
          value = Math.round(prev.value + ratio * (next.value - prev.value))
        } else if (prev) {
          value = prev.value
        } else if (next) {
          value = next.value
        }

        if (value == null) continue
        result.push({
          type: 'heart_rate',
          value: value,
          unit: 'bpm',
          timestamp: new Date(ts).toISOString(),
        })
      }

      console.log('[LiveWatch:companion] Interpolated ' + records.length + ' → ' + result.length + ' records')
      return result
    },

    // ── 上传状态报告 ──

    uploadStatus(status, options) {
      if (!this.state.serverUrl || !this.state.token) return
      const force = options && options.force
      if (!this.state.enabled && !force) {
        console.log('[LiveWatch:companion] Upload disabled, skip status')
        return
      }
      const isPending = options && options.pending

      fetch({
        url: this.state.serverUrl.replace(/\/+$/, '') + '/api/report',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.state.token,
        },
        body: JSON.stringify(status),
      }).then(res => {
        if (res.status >= 200 && res.status < 300) {
          console.log('[LiveWatch:companion] Status upload OK')
          if (isPending) settings.settingsStorage.removeItem(PENDING_STATUS_KEY)
        } else {
          console.warn('[LiveWatch:companion] Status upload HTTP ' + res.status)
          if (!isPending && shouldRetryStatus(res.status)) this.queuePendingStatus(status)
        }
      }).catch(err => {
        console.error('[LiveWatch:companion] Status upload failed: ' + (err.message || err))
        if (!isPending) this.queuePendingStatus(status)
      })
    },
    // ── 上传健康数据（心率/血氧/体温/状态派生数据） ──

    uploadHealthRecords(records, options) {
      if (!this.state.serverUrl || !this.state.token) return
      const force = options && options.force
      if (!this.state.enabled && !force) {
        console.log('[LiveWatch:companion] Upload disabled, skip health records')
        return
      }
      const isPending = options && options.pending

      const chunks = chunkRecords(records, HEALTH_UPLOAD_CHUNK_SIZE)
      let uploaded = 0

      const uploadNext = (index) => {
        if (index >= chunks.length) {
          if (isPending) settings.settingsStorage.removeItem(PENDING_HEALTH_KEY)
          return
        }
        const chunk = chunks[index]
        const payload = { records: chunk }

        fetch({
          url: this.state.serverUrl.replace(/\/+$/, '') + '/api/health-data',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + this.state.token,
          },
          body: JSON.stringify(payload),
        }).then(res => {
          if (res.status >= 200 && res.status < 300) {
            uploaded += chunk.length
            console.log('[LiveWatch:companion] Health upload OK: ' + chunk.length + ' records')
            uploadNext(index + 1)
          } else {
            console.warn('[LiveWatch:companion] Health upload HTTP ' + res.status)
            if (!isPending && shouldRetryStatus(res.status)) this.queuePendingHealthRecords(concatChunks(chunks, index))
          }
        }).catch(err => {
          console.error('[LiveWatch:companion] Health upload failed: ' + (err.message || err))
          if (!isPending) this.queuePendingHealthRecords(concatChunks(chunks, index))
        })
      }

      uploadNext(0)
    },

    restoreConfig() {
      try {
        const raw = settings.settingsStorage.getItem('livewatch_config')
        if (raw) {
          const saved = JSON.parse(raw)
          if (saved.serverUrl) this.state.serverUrl = cleanServerUrl(saved.serverUrl)
          if (saved.token) this.state.token = cleanToken(saved.token)
          if (saved.syncInterval) this.state.syncInterval = clampSyncIntervalSeconds(saved.syncInterval)
          if (saved.enabled !== undefined) this.state.enabled = Boolean(saved.enabled)
          SENSOR_KEYS.forEach((key) => {
            if (saved[key] !== undefined) this.state[key] = Boolean(saved[key])
          })
        }
      } catch (e) { /* no saved config */ }
    },

    persistConfig() {
      try {
        settings.settingsStorage.setItem('livewatch_config', JSON.stringify({
          serverUrl: this.state.serverUrl,
          token: this.state.token,
          syncInterval: this.state.syncInterval,
          enabled: this.state.enabled,
          sensorHeartRate: this.state.sensorHeartRate,
          sensorBattery: this.state.sensorBattery,
          sensorStep: this.state.sensorStep,
          sensorSleep: this.state.sensorSleep,
          sensorBodyTemp: this.state.sensorBodyTemp,
          sensorSpo2: this.state.sensorSpo2,
          sensorStress: this.state.sensorStress,
        }))
      } catch (e) { /* settings may be unavailable in preview */ }
    },
  }),
)
