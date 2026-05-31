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

function cleanToken(value) {
  return String(value || '').replace(/^Bearer\s+/i, '').trim()
}

AppSideService(
  BaseSideService({
    state: {
      serverUrl: '',
      token: '',
      syncInterval: 300,
      enabled: false,
      bleListenerReady: false,
    },

    onInit() {
      console.log('[COMPANION] init')
      this.restoreConfig()
      this.initBleListener()
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
          })
          break
        }
        case 'START': {
          this.state.serverUrl = (params && params.serverUrl) || this.state.serverUrl
          this.state.token = cleanToken((params && params.token) || this.state.token)
          this.state.syncInterval = Number((params && params.syncInterval) || 300)
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
          var self = this
          this.doUpload(url, tok, { app_id: 'zepp_watch', window_title: '手表在线', timestamp: new Date().toISOString(), extra: { device: { platform: 'zepp', capability_mode: 'normal', device_kind: 'watch', last_sample_at: new Date().toISOString() } } }, res)
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

    // ── 设置变更实时同步（来自设置应用） ──
    onSettingsChange({ key, newValue }) {
      if (key === 'livewatch_config' && newValue) {
        try {
          const cfg = JSON.parse(newValue)
          if (cfg.serverUrl !== undefined) this.state.serverUrl = cfg.serverUrl
          if (cfg.token !== undefined) this.state.token = cleanToken(cfg.token)
          if (cfg.syncInterval !== undefined) this.state.syncInterval = Number(cfg.syncInterval)
          if (cfg.enabled !== undefined) {
            this.state.enabled = Boolean(cfg.enabled)
            console.log('[LiveWatch:companion] Settings changed, enabled=' + this.state.enabled)
          }
        } catch (e) {
          console.warn('[LiveWatch:companion] Failed to parse settings change: ' + e.message)
        }
      }
    },

    initBleListener() {
      if (this.state.bleListenerReady) return
      try {
        if (typeof messaging === 'undefined' || !messaging.peerSocket) {
          console.warn('[LiveWatch:companion] messaging.peerSocket unavailable')
          return
        }
        var self = this
        messaging.peerSocket.addListener('message', function (payload) {
          try {
            var msg = JSON.parse(Buffer.from(payload).toString('utf-8'))
            if (msg && msg.type === 'batch_data') {
              console.log('[LiveWatch:companion] BLE batch received')
              self.handleBatchData(msg.payload, function () {})
            }
          } catch (e) {
            console.warn('[LiveWatch:companion] BLE payload parse failed: ' + ((e && e.message) || e))
          }
        })
        this.state.bleListenerReady = true
        console.log('[LiveWatch:companion] BLE listener ready')
      } catch (e) {
        console.warn('[LiveWatch:companion] BLE listener init failed: ' + ((e && e.message) || e))
      }
    },

    // ── 处理手表端批量数据 ──

    handleBatchData(params, res) {
      if (!params || !this.state.serverUrl || !this.state.token) {
        if (res) res({ error: 'invalid params or config' }, null)
        return
      }

      // Compact payload is the BLE format. Verbose payload is accepted for
      // compatibility with older manual/debug senders.
      const expanded = params.status ? params : this.expandCompact(params)
      if (!expanded) {
        if (res) res(null, { ok: false, reason: 'invalid compact payload' })
        return
      }

      const { status, heart_rate_history, spo2_history, body_temp_history } = expanded

      // 1. Status report
      if (status) {
        this.uploadStatus(status)
      }

      // 2. Interpolate + upload HR history (phone has power for this)
      if (heart_rate_history && heart_rate_history.length > 0) {
        const interpolated = this.interpolateHeartRate(heart_rate_history)
        if (interpolated.length > 0) {
          this.uploadHeartRateHistory(interpolated)
        }
      }

      // 3. Upload SpO2 history (no interpolation needed)
      if (spo2_history && spo2_history.length > 0) {
        this.uploadHealthData(spo2_history, 'spo2')
      }

      // 4. Upload body temp history (no interpolation needed)
      if (body_temp_history && body_temp_history.length > 0) {
        this.uploadHealthData(body_temp_history, 'body_temp')
      }

      if (res) res(null, { ok: true, message: 'processing' })
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
          unit: '°C',
          timestamp: new Date(todayMs + m * 60000).toISOString(),
        }))

        return {
          status: verboseStatus,
          heart_rate_history: verboseHr,
          spo2_history: verboseSpo2,
          body_temp_history: verboseTemp,
        }
      } catch (e) {
        console.error('[LiveWatch:companion] expandCompact failed: ' + e.message)
        return null
      }
    },

    // ── O(N) 心率插值算法 ──
    // 输入：非零心率数据点（稀疏）
    // 输出：每分钟一个数据点（连续，含插值）

    interpolateHeartRate(records) {
      if (!records || records.length === 0) return []

      // 1. 按时间排序
      const sorted = records.slice().sort((a, b) => {
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      })

      // 2. 构建时间→值映射
      const dataMap = new Map()
      sorted.forEach(r => {
        const ts = new Date(r.timestamp).getTime()
        dataMap.set(ts, r.value)
      })

      // 3. 确定时间范围（从第一个到最后一个）
      const firstTs = new Date(sorted[0].timestamp).getTime()
      const lastTs = new Date(sorted[sorted.length - 1].timestamp).getTime()

      // 4. 按分钟填充，使用线性插值
      const result = []
      const sortedKeys = Array.from(dataMap.keys()).sort((a, b) => a - b)

      for (let ts = firstTs; ts <= lastTs; ts += 60000) {
        // 查找 ts 前后的有效数据点
        let prevTs = null, prevVal = null
        let nextTs = null, nextVal = null

        for (let i = 0; i < sortedKeys.length; i++) {
          const key = sortedKeys[i]
          if (key <= ts) {
            prevTs = key
            prevVal = dataMap.get(key)
          }
          if (key >= ts && nextTs === null) {
            nextTs = key
            nextVal = dataMap.get(key)
          }
        }

        let value = null

        // 情况1：ts 有精确值
        if (dataMap.has(ts)) {
          value = dataMap.get(ts)
        }
        // 情况2：前后都有值，线性插值
        else if (prevVal !== null && nextVal !== null) {
          const ratio = (ts - prevTs) / (nextTs - prevTs)
          value = Math.round(prevVal + ratio * (nextVal - prevVal))
        }
        // 情况3：只有前值，使用前值
        else if (prevVal !== null) {
          value = prevVal
        }
        // 情况4：只有后值，使用后值
        else if (nextVal !== null) {
          value = nextVal
        }

        if (value !== null) {
          result.push({
            type: 'heart_rate',
            value: value,
            unit: 'bpm',
            timestamp: new Date(ts).toISOString(),
          })
        }
      }

      console.log('[LiveWatch:companion] Interpolated ' + records.length + ' → ' + result.length + ' records')
      return result
    },

    // ── 上传状态报告 ──

    uploadStatus(status) {
      if (!this.state.serverUrl || !this.state.token) return
      if (!this.state.enabled) {
        console.log('[LiveWatch:companion] Upload disabled, skip status')
        return
      }

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
        } else {
          console.warn('[LiveWatch:companion] Status upload HTTP ' + res.status)
        }
      }).catch(err => {
        console.error('[LiveWatch:companion] Status upload failed: ' + (err.message || err))
      })
    },
    // 无视 enabled 的上传（手动触发用）
    async doUpload(url, token, data, res) {
      var apiUrl = url.replace(/\/+$/, '') + '/api/report'
      var bearerToken = cleanToken(token)
      try {
        var r = await fetch({
          url: apiUrl, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + bearerToken },
          body: JSON.stringify(data),
        })
        var body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
        var ok = r.status >= 200 && r.status < 300
        if (res) res(null, { ok: ok, status: r.status, body: body.substring(0, 200) })
      } catch (err) {
        if (res) res(null, { ok: false, error: (err && err.message) || String(err) })
      }
    },

    // ── 上传心率历史 ──

    uploadHeartRateHistory(records) {
      if (!this.state.serverUrl || !this.state.token) return
      if (!this.state.enabled) {
        console.log('[LiveWatch:companion] Upload disabled, skip HR history')
        return
      }

      const payload = { records: records }

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
          console.log('[LiveWatch:companion] HR history upload OK: ' + records.length + ' records')
        } else {
          console.warn('[LiveWatch:companion] HR history upload HTTP ' + res.status)
        }
      }).catch(err => {
        console.error('[LiveWatch:companion] HR history upload failed: ' + (err.message || err))
      })
    },

    // ── 上传健康数据（SpO2/体温等） ──

    uploadHealthData(records, type) {
      if (!this.state.serverUrl || !this.state.token) return
      if (!this.state.enabled) {
        console.log('[LiveWatch:companion] Upload disabled, skip ' + type)
        return
      }

      const payload = { records: records }

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
          console.log('[LiveWatch:companion] ' + type + ' upload OK: ' + records.length + ' records')
        } else {
          console.warn('[LiveWatch:companion] ' + type + ' upload HTTP ' + res.status)
        }
      }).catch(err => {
        console.error('[LiveWatch:companion] ' + type + ' upload failed: ' + (err.message || err))
      })
    },

    restoreConfig() {
      try {
        const raw = settings.settingsStorage.getItem('livewatch_config')
        if (raw) {
          const saved = JSON.parse(raw)
          if (saved.serverUrl) this.state.serverUrl = saved.serverUrl
          if (saved.token) this.state.token = cleanToken(saved.token)
          if (saved.syncInterval) this.state.syncInterval = Number(saved.syncInterval)
          if (saved.enabled !== undefined) this.state.enabled = Boolean(saved.enabled)
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
        }))
      } catch (e) { /* settings may be unavailable in preview */ }
    },
  }),
)
