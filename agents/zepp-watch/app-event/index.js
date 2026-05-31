// ────────────────────────────────────────────
//  Live Watch — App Event Handler
//  alarm 唤醒时检查配置，仅 enabled=true 时启动 app-service
// ────────────────────────────────────────────

AppEvent({
  onInit() {
    console.log('[LiveWatch:event] init')

    try {
      var storage = require('@zos/settings').settingsStorage
      var raw = storage.getItem('livewatch_config')
      if (raw) {
        var cfg = JSON.parse(raw)
        if (cfg && cfg.enabled && cfg.serverUrl && cfg.token) {
          console.log('[LiveWatch:event] enabled, starting app-service')
          var as = require('@zos/app-service')
          as.start({
            url: 'app-service/live-watch',
            param: 'source=app-event',
            complete_func: function (info) {
              console.log('[LiveWatch:event] start result=' + JSON.stringify(info))
            },
          })
        } else {
          console.log('[LiveWatch:event] disabled or no config, skip')
        }
      }
    } catch (e) {
      console.log('[LiveWatch:event] error: ' + (e && e.message ? e.message : e))
    }
  },

  onDestroy() {
    console.log('[LiveWatch:event] destroy')
  },
})
