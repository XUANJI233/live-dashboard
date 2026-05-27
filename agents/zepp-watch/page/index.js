import { BasePage } from '@zeppos/zml/base-page'

Page(
  BasePage({
    state: {
      serverUrl: '',
      token: '',
      syncInterval: 30,
      lastSyncAt: '--',
      batteryLevel: '--',
      steps: '--',
      heartRate: '--',
      status: '未连接',
    },

    onInit() {
      // Load saved settings
      const saved = this.getStoredSettings()
      if (saved.serverUrl) this.state.serverUrl = saved.serverUrl
      if (saved.token) this.state.token = saved.token
      if (saved.syncInterval) this.state.syncInterval = saved.syncInterval
    },

    // Save settings and notify side-service
    saveSettings() {
      const settings = {
        serverUrl: this.state.serverUrl.trim(),
        token: this.state.token.trim(),
        syncInterval: this.state.syncInterval,
      }
      // Store via SettingsPlugin (synced to side-service)
      this.setSideSettings(settings)
      this.log('Settings saved: ' + JSON.stringify(settings))
    },

    // Start background sync via side-service
    startSync() {
      this.saveSettings()
      this.callSideService({ method: 'startSync' })
      this.state.status = '同步已启动'
    },

    // Stop background sync
    stopSync() {
      this.callSideService({ method: 'stopSync' })
      this.state.status = '同步已停止'
    },

    // Called by side-service to update UI status
    onStatusUpdate(data) {
      if (data.batteryLevel !== undefined) this.state.batteryLevel = String(data.batteryLevel) + '%'
      if (data.steps !== undefined) this.state.steps = String(data.steps)
      if (data.heartRate !== undefined) this.state.heartRate = String(data.heartRate)
      if (data.lastSyncAt) this.state.lastSyncAt = data.lastSyncAt
      this.state.status = data.error ? '同步失败: ' + data.error : '运行中'
    },

    getStoredSettings() {
      // SettingsPlugin handles persistent storage
      return {}
    },

    setSideSettings(settings) {
      this.callSideService({ method: 'updateConfig', params: settings })
    },

    callSideService(data) {
      this.request({
        method: data.method,
        params: data.params || {},
      })
    },
  }),
)