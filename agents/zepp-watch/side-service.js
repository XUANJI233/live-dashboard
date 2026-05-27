// ────────────────────────────────────────────
//  Live Watch — Companion Side Service
//  运行在手机 Zepp 伴生侧，负责：
//  1. 页面 ↔ 设备 App Service 的消息中继
//  2. 配置持久化 (通过 zml SettingsPlugin)
//  3. 手表数据采集已移至 app-service/live-watch.js
// ────────────────────────────────────────────

import { BaseSideService } from '@zeppos/zml/base-side'

AppSideService(
  BaseSideService({
    state: {
      serverUrl: '',
      token: '',
      syncInterval: 30,
      enabled: false,
    },

    onInit() {
      console.log('[LiveWatch:companion] Side service init')
      this.restoreConfig()
    },

    onRun() {
      console.log('[LiveWatch:companion] Side service running')
    },

    onDestroy() {
      console.log('[LiveWatch:companion] Side service destroy')
    },

    // ── Page → Companion → Device relay ──

    onRequest(req, res) {
      const { method, params } = req
      switch (method) {
        case 'START': {
          this.state.serverUrl = params?.serverUrl || this.state.serverUrl
          this.state.token = params?.token || this.state.token
          this.state.syncInterval = params?.syncInterval || this.state.syncInterval
          this.state.enabled = true
          this.persistConfig()
          this.callDevice({ method: 'START', params: this.state })
          res(null, { ok: true, status: 'started' })
          break
        }
        case 'STOP': {
          this.state.enabled = false
          this.persistConfig()
          this.callDevice({ method: 'STOP' })
          res(null, { ok: true, status: 'stopped' })
          break
        }
        case 'CONFIG': {
          if (params?.serverUrl !== undefined) this.state.serverUrl = params.serverUrl
          if (params?.token !== undefined) this.state.token = params.token
          if (params?.syncInterval !== undefined) this.state.syncInterval = params.syncInterval
          this.persistConfig()
          this.callDevice({ method: 'CONFIG', params: this.state })
          res(null, { ok: true })
          break
        }
        default:
          res({ error: 'unknown method' }, null)
      }
    },

    callDevice(data) {
      try {
        if (typeof this.sendToDevice === 'function') {
          this.sendToDevice(data)
        }
      } catch (e) {
        console.warn('[LiveWatch:companion] callDevice failed: ' + e.message)
      }
    },

    restoreConfig() {
      try {
        const saved = this.getSettings()
        if (saved?.serverUrl) this.state.serverUrl = saved.serverUrl
        if (saved?.token) this.state.token = saved.token
        if (saved?.syncInterval) this.state.syncInterval = Number(saved.syncInterval)
        if (saved?.enabled !== undefined) this.state.enabled = Boolean(saved.enabled)
      } catch (e) { /* no saved config */ }
    },

    persistConfig() {
      try {
        this.setSettings({
          serverUrl: this.state.serverUrl,
          token: this.state.token,
          syncInterval: this.state.syncInterval,
          enabled: this.state.enabled,
        })
      } catch (e) { /* settings may be unavailable in preview */ }
    },
  }),
)