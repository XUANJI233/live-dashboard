// ────────────────────────────────────────────
//  Live Watch — Device Page (Zepp OS v3 / API 4.0)
//
//  使用 @zos/ui 模块化 API（v3 推荐），不依赖 hmUI 全局变量
//  onInit 时从 settingsStorage 加载配置，确保设置页修改后手表端同步
// ────────────────────────────────────────────

import { BasePage } from '@zeppos/zml/base-page'
import { px } from '@zos/utils'
import { getDeviceInfo, SCREEN_SHAPE_ROUND } from '@zos/device'
import { createWidget, prop, align } from '@zos/ui'
import { TEXT, BUTTON } from '@zos/ui/page_widget'
import { startAppService, stopAppService } from '@zos/app-service'
import { settingsStorage } from '@zos/settings'

const SERVICE_PATH = 'app-service/live-watch'

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
      syncInterval: 300,
      enabled: false,
      status: '未启动',
      statusColor: 0x999999,
    },

    onInit() {
      // 从 settingsStorage 加载配置（与设置页同步）
      this.loadConfig()
      this.buildUI()
    },

    loadConfig() {
      try {
        const raw = settingsStorage.getItem('livewatch_config')
        if (raw) {
          const cfg = JSON.parse(raw)
          if (cfg.serverUrl) this.state.serverUrl = cfg.serverUrl
          if (cfg.token) this.state.token = cfg.token
          if (cfg.syncInterval) this.state.syncInterval = cfg.syncInterval
          if (cfg.enabled !== undefined) this.state.enabled = cfg.enabled
        }
      } catch (e) {
        console.warn('[LiveWatch:page] loadConfig failed: ' + e.message)
      }
    },

    buildUI() {
      let y = MARGIN_TOP

      // 标题
      createWidget(TEXT, {
        x: px(MARGIN_X), y: px(y),
        w: px(FIELD_W), h: px(36),
        text: 'Live Watch',
        text_size: px(28),
        color: 0xffffff,
        align_h: align.CENTER_H,
      })
      y += 44

      // 服务器地址
      createWidget(TEXT, {
        x: px(MARGIN_X), y: px(y),
        w: px(FIELD_W), h: px(24),
        text: '服务器地址',
        text_size: px(20),
        color: 0xaaaaaa,
      })
      y += 26

      // 显示截断的 URL
      const displayUrl = this.state.serverUrl
        ? this.state.serverUrl.replace(/^https?:\/\//, '').substring(0, 24)
        : '未设置（请在手机端配置）'

      this._urlText = createWidget(TEXT, {
        x: px(MARGIN_X), y: px(y),
        w: px(FIELD_W), h: px(FIELD_H),
        text: displayUrl,
        text_size: px(22),
        color: this.state.serverUrl ? 0xffffff : 0xff6600,
      })
      y += FIELD_H + GAP

      // 同步间隔
      this._intervalText = createWidget(TEXT, {
        x: px(MARGIN_X), y: px(y),
        w: px(FIELD_W), h: px(FIELD_H),
        text: '间隔 ' + this.state.syncInterval + ' 秒',
        text_size: px(22),
        color: 0xcccccc,
      })
      y += FIELD_H + GAP * 2

      // 启动按钮
      this._startBtn = createWidget(BUTTON, {
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

      // 停止按钮
      this._stopBtn = createWidget(BUTTON, {
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

      // 状态文本
      this._statusText = createWidget(TEXT, {
        x: px(MARGIN_X), y: px(y),
        w: px(FIELD_W), h: px(36),
        text: this.state.enabled ? '同步已启动' : this.state.status,
        text_size: px(18),
        color: this.state.enabled ? 0x00aa55 : this.state.statusColor,
        align_h: align.CENTER_H,
      })
    },

    onStartClick() {
      if (!this.state.serverUrl || !this.state.token) {
        this.setStatus('请先在手机端配置', 0xff6600)
        return
      }
      const cfg = {
        serverUrl: this.state.serverUrl,
        token: this.state.token,
        syncInterval: this.state.syncInterval,
        enabled: true,
      }
      settingsStorage.setItem('livewatch_config', JSON.stringify(cfg))
      startAppService({ url: SERVICE_PATH })
      this.request({ method: 'START', params: cfg })
      this.state.enabled = true
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
      stopAppService({ url: SERVICE_PATH })
      this.request({ method: 'STOP' })
      this.state.enabled = false
      this.setStatus('同步已停止', 0x999999)
    },

    setStatus(text, color) {
      this.state.status = text
      this.state.statusColor = color || 0x999999
      if (this._statusText) {
        this._statusText.setProperty(prop.MORE, {
          text,
          color: color || 0x999999,
        })
      }
    },
  }),
)
