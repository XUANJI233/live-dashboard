// ────────────────────────────────────────────
//  Live Watch — Companion Side Service
//  运行在手机 Zepp 伴生侧，负责：
//  1. 配置持久化 (settings.settingsStorage)
//  2. 页面请求处理
//  3. 手表数据采集在 app-service/live-watch.js
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
            // Validate: must be a positive number between 60 and 3600 seconds
            if (!isNaN(interval) && interval >= 60 && interval <= 3600) {
              this.state.syncInterval = interval
            } else {
              console.warn('[LiveWatch:companion] Invalid syncInterval:', params.syncInterval, '- keeping current value')
            }
          }
          this.persistConfig()
          res(null, { ok: true })
          break
        }
        default:
          res({ error: 'unknown method' }, null)
      }
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