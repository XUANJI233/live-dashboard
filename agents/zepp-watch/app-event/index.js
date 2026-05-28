// ────────────────────────────────────────────
//  Live Watch — App Event Handler (Zepp OS v3)
//
//  处理系统事件（alarm 唤醒、app 生命周期）
//  与 app-service 分离，避免入口冲突
//
//  参考: https://docs.zepp.com/zh-cn/docs/guides/framework/device/system-event/
// ────────────────────────────────────────────

AppEvent({
  onInit() {
    console.log('[LiveWatch:event] System event init')
    // alarm 唤醒时，重新启动 app-service 执行数据采集
    try {
      const { startAppService } = require('@zos/app-service')
      startAppService({ url: 'app-service/live-watch' })
    } catch (e) {
      console.warn('[LiveWatch:event] Failed to start app-service: ' + e.message)
    }
  },

  onDestroy() {
    console.log('[LiveWatch:event] System event destroy')
  },
})
