import * as hmUI from '@zos/ui'
import { px } from '@zos/utils'
import { set as setAlarm, getAllAlarms, cancel as cancelAlarm } from '@zos/alarm'
import { LocalStorage } from '@zos/storage'
import { BasePage } from '@zeppos/zml/base-page'

var gUrl = '', gToken = '', gRunning = false, gInterval = 300, gPage = null
var gConfig = {}
var gWUrl = null, gWBtn = null, gWUpload = null, gWStatus = null, gWDebug = null
var gWRefresh = null
const CONFIG_KEY = 'lw_cfg'
const MANUAL_FULL_SYNC_KEY = 'lw_manual_full'
const localStorage = new LocalStorage()

function log(msg) { console.log('[WATCH] ' + msg) }

Page(
  BasePage({
    onInit() {
      gPage = this
      log('onInit')
      this.request({ method: 'GET_CONFIG' }).then(function (r) {
        gUrl = r.serverUrl || ''
        gToken = r.token || ''
        gRunning = r.enabled || false
        gInterval = Number(r.syncInterval || 300)
        gConfig = r || {}
        updateUI()
        if (gRunning && gUrl && gToken) {
          persistDeviceConfig(true)
          scheduleWatchService(1, true)
        }
      }).catch(function () {})
    },

    build() {
      log('build')
      hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(42), y: px(40), w: px(396), h: px(24),
        text: 'Live Watch', text_size: px(22), color: 0xffffff, align_h: hmUI.align.CENTER_H,
      })

      gWUrl = hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(24), y: px(72), w: px(432), h: px(18),
        text: '', text_size: px(14), color: 0xaaaaaa, align_h: hmUI.align.CENTER_H,
      })

      gWBtn = hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(42), y: px(110), w: px(396), h: px(50),
        text: '启动同步', text_size: px(22), radius: px(10),
        normal_color: 0x00aa55, press_color: 0x008844,
        click_func: onToggle,
      })

      gWUpload = hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(42), y: px(168), w: px(396), h: px(50),
        text: '手动上传', text_size: px(22), radius: px(10),
        normal_color: 0x3388cc, press_color: 0x226699,
        click_func: onManualUpload,
      })

      gWStatus = hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(42), y: px(230), w: px(396), h: px(20),
        text: '', text_size: px(14), color: 0x888888, align_h: hmUI.align.CENTER_H,
      })

      // Debug line on screen
      gWDebug = hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(10), y: px(260), w: px(460), h: px(180),
        text: '', text_size: px(12), color: 0x666666,
        text_style: hmUI.text_style.WRAP,
      })
    },

    onDestroy() { log('destroy') },
  }),
)

function dbg(msg) {
  log(msg)
  if (gWDebug) gWDebug.setProperty(hmUI.prop.MORE, { text: msg })
}

function onToggle() {
  dbg('toggle running=' + gRunning)
  if (!gUrl || !gToken) return
  var next = !gRunning
  var method = next ? 'START' : 'STOP'
  gPage.request({ method: method, params: { serverUrl: gUrl, token: gToken, syncInterval: gInterval } })
    .then(function (r) {
      if (next) {
        persistDeviceConfig(true)
        var alarmId = scheduleWatchService(1, true)
        dbg('start ok alarm=' + alarmId + ' ' + JSON.stringify(r))
      } else {
        persistDeviceConfig(false)
        cancelWatchServiceAlarms()
        dbg('stop ok ' + JSON.stringify(r))
      }
      gRunning = next
      updateUI()
    })
    .catch(function (e) {
      dbg('toggle failed: ' + e)
      hmUI.showToast({ text: '切换失败' })
    })
}

function persistDeviceConfig(enabled) {
  try {
    var cfg = {
      serverUrl: gUrl,
      token: gToken,
      syncInterval: gInterval,
      enabled: Boolean(enabled),
      sensorHeartRate: gConfig.sensorHeartRate !== false,
      sensorBattery: gConfig.sensorBattery !== false,
      sensorStep: gConfig.sensorStep !== false,
      sensorSleep: gConfig.sensorSleep !== false,
      sensorBodyTemp: gConfig.sensorBodyTemp !== false,
      sensorSpo2: Boolean(gConfig.sensorSpo2),
      sensorStress: Boolean(gConfig.sensorStress),
    }
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg))
    dbg('device config saved')
  } catch (e) {
    dbg('save device config failed: ' + ((e && e.message) || e))
  }
}

function onManualUpload() {
  if (!gUrl || !gToken) { hmUI.showToast({ text: '请先配置' }); return }
  hmUI.showToast({ text: '全量上传已排队' })
  persistDeviceConfig(gRunning)
  try {
    localStorage.setItem(MANUAL_FULL_SYNC_KEY, 1)
    scheduleWatchService(1, false)
  } catch (e) {
    dbg('manual alarm failed: ' + ((e && e.message) || e))
  }
  gPage.request({ method: 'UPLOAD_NOW', params: { serverUrl: gUrl, token: gToken, forceFull: true } })
    .then(function (r) { dbg('manual queued ' + JSON.stringify(r)) })
    .catch(function (e) { dbg('manual side failed: ' + e) })
}

function onRefreshConfig() {
  hmUI.showToast({ text: '刷新配置...' })
  gPage.request({ method: 'GET_CONFIG' }).then(function (r) {
    gUrl = r.serverUrl || ''
    gToken = r.token || ''
    gRunning = r.enabled || false
    gInterval = Number(r.syncInterval || 300)
    gConfig = r || {}
    persistDeviceConfig(gRunning)
    updateUI()
    hmUI.showToast({ text: '配置已更新' })
  }).catch(function (e) {
    hmUI.showToast({ text: '刷新失败' })
  })
}

function updateUI() {
  var has = gUrl && gToken
  if (gWUrl) {
    var u = has ? gUrl.replace(/^https?:\/\//, '') : '未配置'
    if (u.length > 36) u = u.substring(0, 34) + '..'
    gWUrl.setProperty(hmUI.prop.MORE, { text: u, color: has ? 0xaaaaaa : 0xff6600 })
  }
  // 重建按钮实现切换
  if (gWBtn) { hmUI.deleteWidget(gWBtn) }
  if (gWUpload) { hmUI.deleteWidget(gWUpload) }
  if (gWRefresh) { hmUI.deleteWidget(gWRefresh) }
  gWBtn = hmUI.createWidget(hmUI.widget.BUTTON, {
    x: px(42), y: px(150), w: px(396), h: px(55),
    text: gRunning ? '停止同步' : '启动同步', text_size: px(24), radius: px(12),
    normal_color: gRunning ? 0xcc3333 : 0x00aa55,
    press_color: gRunning ? 0x992222 : 0x008844,
    click_func: onToggle,
  })
  gWUpload = hmUI.createWidget(hmUI.widget.BUTTON, {
    x: px(42), y: px(215), w: px(396), h: px(55),
    text: '手动上传', text_size: px(24), radius: px(12),
    normal_color: 0x3388cc, press_color: 0x226699,
    click_func: onManualUpload,
  })
  gWRefresh = hmUI.createWidget(hmUI.widget.BUTTON, {
    x: px(42), y: px(280), w: px(396), h: px(48),
    text: '刷新配置', text_size: px(20), radius: px(10),
    normal_color: 0x555555, press_color: 0x333333,
    click_func: onRefreshConfig,
    })
  gWStatus.setProperty(hmUI.prop.MORE, {
    text: gRunning ? '正在后台同步' : (has ? '已配置，点击启动' : '请在手机端设置'),
    color: gRunning ? 0x00aa55 : (has ? 0xaaaaaa : 0x888888)
  })
}

function scheduleWatchService(delaySec, store) {
  try {
    return setAlarm({
      url: 'app-service/live-watch',
      delay: delaySec,
      store: Boolean(store),
    })
  } catch (e) {
    dbg('schedule failed: ' + ((e && e.message) || e))
    return null
  }
}

function cancelWatchServiceAlarms() {
  try {
    var alarms = getAllAlarms()
    if (alarms && alarms.length) {
      alarms.forEach(function (id) { cancelAlarm(id) })
    }
  } catch (e) {}
}
