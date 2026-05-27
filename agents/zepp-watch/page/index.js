import { BasePage } from '@zeppos/zml/base-page'
import { px } from '@zos/utils'
import { getDeviceInfo, SCREEN_SHAPE_ROUND } from '@zos/device'
import { startAppService, stopAppService } from '@zos/app-service'
import { settingsStorage } from '@zos/settings'

// T-Rex 3: 480×480 round, effective ~324×324 circle
const deviceInfo = getDeviceInfo()
const IS_ROUND = deviceInfo.screenShape === SCREEN_SHAPE_ROUND

const MARGIN_X = IS_ROUND ? 78 : 24
const MARGIN_TOP = IS_ROUND ? 90 : 60
const FIELD_W = IS_ROUND ? 324 : 432
const FIELD_H = 56
const BTN_W = IS_ROUND ? 324 : 432
const BTN_H = 64
const GAP = 12

Page(
  BasePage({
    state: {
      serverUrl: '',
      token: '',
      syncInterval: 30,
      status: '未启动',
      statusColor: 0x999999,
    },

    onInit() {
      this.buildUI()
    },

    buildUI() {
      let y = MARGIN_TOP

      hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(MARGIN_X), y: px(y),
        w: px(FIELD_W), h: px(36),
        text: 'Live Watch',
        text_size: px(28),
        color: 0xffffff,
        align_h: hmUI.align.CENTER_H,
      })
      y += 44

      hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(MARGIN_X), y: px(y),
        w: px(FIELD_W), h: px(24),
        text: '服务器地址',
        text_size: px(20),
        color: 0xaaaaaa,
      })
      y += 26

      this._urlText = hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(MARGIN_X), y: px(y),
        w: px(FIELD_W), h: px(FIELD_H),
        text: this.state.serverUrl || '未设置',
        text_size: px(24),
        color: 0xffffff,
      })
      y += FIELD_H + GAP

      this._intervalText = hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(MARGIN_X), y: px(y),
        w: px(FIELD_W), h: px(FIELD_H),
        text: this.state.syncInterval + ' 秒',
        text_size: px(24),
        color: 0xffffff,
      })
      y += FIELD_H + GAP * 2

      this._startBtn = hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(MARGIN_X), y: px(y),
        w: px(BTN_W), h: px(BTN_H),
        text: '启动同步',
        text_size: px(26),
        radius: px(12),
        normal_color: 0x00aa55,
        press_color: 0x008844,
        click_func: () => this.onStartClick(),
      })
      y += BTN_H + GAP

      this._stopBtn = hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(MARGIN_X), y: px(y),
        w: px(BTN_W), h: px(BTN_H),
        text: '停止同步',
        text_size: px(26),
        radius: px(12),
        normal_color: 0xcc3333,
        press_color: 0x992222,
        click_func: () => this.onStopClick(),
      })
      y += BTN_H + GAP * 2

      this._statusText = hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(MARGIN_X), y: px(y),
        w: px(FIELD_W), h: px(36),
        text: this.state.status,
        text_size: px(18),
        color: this.state.statusColor,
        align_h: hmUI.align.CENTER_H,
      })
    },

    onStartClick() {
      if (!this.state.serverUrl || !this.state.token) {
        this.setStatus('请先配置服务器', 0xff6600)
        return
      }
      // Persist config to settingsStorage (shared with Device App Service)
      const cfg = {
        serverUrl: this.state.serverUrl,
        token: this.state.token,
        syncInterval: this.state.syncInterval,
        enabled: true,
      }
      settingsStorage.setItem('livewatch_config', JSON.stringify(cfg))
      // Start Device App Service on watch
      startAppService({ url: 'app-service/live-watch.js' })
      // Also notify companion side-service
      this.request({
        method: 'START',
        params: cfg,
      })
      this.setStatus('同步已启动', 0x00aa55)
    },

    onStopClick() {
      const cfg = {
        serverUrl: this.state.serverUrl,
        token: this.state.token,
        syncInterval: this.state.syncInterval,
        enabled: false,
      }
      settingsStorage.setItem('livewatch_config', JSON.stringify(cfg))
      stopAppService({ url: 'app-service/live-watch.js' })
      this.request({ method: 'STOP' })
      this.setStatus('同步已停止', 0x999999)
    },

    setStatus(text, color) {
      this.state.status = text
      this.state.statusColor = color || 0x999999
      if (this._statusText) {
        this._statusText.setProperty(hmUI.prop.MORE, { text, color: color || 0x999999 })
      }
    },
  }),
)