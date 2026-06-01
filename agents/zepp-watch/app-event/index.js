// ────────────────────────────────────────────
//  Live Watch — App Event Handler
//  alarm 唤醒时检查配置，仅 enabled=true 时启动 app-service
// ────────────────────────────────────────────

import { LocalStorage } from '@zos/storage'

const CONFIG_KEY = 'lw_cfg'
const localStorage = new LocalStorage()

AppEvent({
  onInit() {
    console.log('[LiveWatch:event] init')

    try {
      var raw = localStorage.getItem(CONFIG_KEY, '')
      if (raw) {
        var cfg = typeof raw === 'string' ? JSON.parse(raw) : raw
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
