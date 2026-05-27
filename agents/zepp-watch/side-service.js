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

AppSideService(
  BaseSideService({
    state: {
      serverUrl: '',
      token: '',
      syncInterval: 300,
      enabled: false,
    },

    onInit() {
      console.log('[LiveWatch:companion] init')
      this.restoreConfig()
    },

    onRun() {
      console.log('[LiveWatch:companion] running')
    },

    onDestroy() {
      console.log('[LiveWatch:companion] destroy')
    },

    onRequest(req, res) {
      const { method, params } = req
      switch (method) {
        case 'START': {
          this.state.serverUrl = params?.serverUrl || this.state.serverUrl
          this.state.token = params?.token || this.state.token
          this.state.syncInterval = Number(params?.syncInterval) || 300
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
        case 'CONFIG': {
          if (params?.serverUrl !== undefined) this.state.serverUrl = params.serverUrl
          if (params?.token !== undefined) this.state.token = params.token
          if (params?.syncInterval !== undefined) {
            const interval = Number(params.syncInterval)
            if (!isNaN(interval) && interval >= 60 && interval <= 3600) {
              this.state.syncInterval = interval
            }
          }
          this.persistConfig()
          res(null, { ok: true })
          break
        }
        case 'BATCH_DATA': {
          // 接收手表端批量数据，进行插值后上传
          this.handleBatchData(params, res)
          break
        }
        default:
          res({ error: 'unknown method' }, null)
      }
    },

    // ── 处理手表端批量数据 ──

    handleBatchData(params, res) {
      if (!params || !this.state.serverUrl || !this.state.token) {
        res({ error: 'invalid params or config' }, null)
        return
      }

      const { status, heart_rate_history } = params

      // 1. 上传状态报告
      if (status) {
        this.uploadStatus(status)
      }

      // 2. 插值并上传心率历史
      if (heart_rate_history && heart_rate_history.length > 0) {
        const interpolated = this.interpolateHeartRate(heart_rate_history)
        if (interpolated.length > 0) {
          this.uploadHeartRateHistory(interpolated)
        }
      }

      res(null, { ok: true, message: 'processing' })
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

      fetch({
        url: this.state.serverUrl.replace(/\/+$/, '') + '/api/report',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.state.token,
        },
        body: JSON.stringify(status),
        timeout: 10000,
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

    // ── 上传心率历史 ──

    uploadHeartRateHistory(records) {
      if (!this.state.serverUrl || !this.state.token) return

      const payload = { records: records }

      fetch({
        url: this.state.serverUrl.replace(/\/+$/, '') + '/api/health-data',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.state.token,
        },
        body: JSON.stringify(payload),
        timeout: 15000,
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

    restoreConfig() {
      try {
        const raw = settings.settingsStorage.getItem('livewatch_config')
        if (raw) {
          const saved = JSON.parse(raw)
          if (saved.serverUrl) this.state.serverUrl = saved.serverUrl
          if (saved.token) this.state.token = saved.token
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