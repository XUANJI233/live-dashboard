import { getDeviceInfo } from '@zos/device'
import {
  Barometer,
  Battery,
  BloodOxygen,
  BodyTemperature,
  Calorie,
  HeartRate,
  Sleep,
  Stand,
  Step,
  Stress,
  Wear,
  checkSensor,
} from '@zos/sensor'
import { LocalStorage } from '@zos/storage'
import { createWidget, widget, align, text_style, prop } from '@zos/ui'
import { log } from '@zos/utils'
import { BasePage } from '@zeppos/zml/base-page'

const logger = log.getLogger('LiveDashboardPage')
const { width: DEVICE_WIDTH, height: DEVICE_HEIGHT } = getDeviceInfo()
const heartRate = new HeartRate()
const storage = new LocalStorage()

function sensorAvailable(SensorClass) {
  try {
    return checkSensor(SensorClass)
  } catch (_) {
    return true
  }
}

function readSensor(SensorClass, reader) {
  try {
    if (!sensorAvailable(SensorClass)) return undefined
    const sensor = new SensorClass()
    return reader(sensor)
  } catch (_) {
    return undefined
  }
}

function readWatchMetrics(heart_rate) {
  const metrics = {}
  if (heart_rate > 0) metrics.heart_rate = heart_rate

  const battery = readSensor(Battery, (sensor) => sensor.getCurrent())
  if (typeof battery === 'number') metrics.battery_percent = battery

  const wear = readSensor(Wear, (sensor) => sensor.getStatus())
  if (typeof wear === 'number') metrics.wear_status = wear

  const sleep = readSensor(Sleep, (sensor) => sensor.getSleepingStatus())
  if (typeof sleep === 'number') metrics.sleep_status = sleep

  const spo2 = readSensor(BloodOxygen, (sensor) => sensor.getCurrent())
  if (spo2 && typeof spo2.value === 'number') metrics.spo2 = spo2.value

  const temp = readSensor(BodyTemperature, (sensor) => sensor.getCurrent())
  if (temp && typeof temp.current === 'number' && temp.current > -100) metrics.body_temperature = temp.current

  const stand = readSensor(Stand, (sensor) => sensor.getCurrent())
  if (typeof stand === 'number') metrics.stand_hours = stand

  const stress = readSensor(Stress, (sensor) => sensor.getCurrent())
  if (stress && typeof stress.value === 'number') metrics.stress = stress.value

  const step = readSensor(Step, (sensor) => sensor.getCurrent())
  if (typeof step === 'number') metrics.steps = step

  const calorie = readSensor(Calorie, (sensor) => sensor.getCurrent())
  if (typeof calorie === 'number') metrics.calorie = calorie

  const barometer = readSensor(Barometer, (sensor) => ({
    air_pressure: sensor.getAirPressure(),
    altitude: sensor.getAltitude(),
  }))
  if (barometer) {
    if (typeof barometer.air_pressure === 'number') metrics.air_pressure = barometer.air_pressure
    if (typeof barometer.altitude === 'number') metrics.altitude = barometer.altitude
  }

  return metrics
}

const MIN_MANUAL_INTERVAL_MS = 30 * 1000
const CARD_X = px(28)
const CARD_W = DEVICE_WIDTH - CARD_X * 2
const TOP_Y = Math.max(px(22), Math.floor(DEVICE_HEIGHT * 0.06))
const BUTTON_W = Math.min(px(320), DEVICE_WIDTH - px(80))
const BUTTON_X = Math.floor((DEVICE_WIDTH - BUTTON_W) / 2)
const FOOTER_Y = Math.max(px(340), DEVICE_HEIGHT - px(44))

function formatWait(waitMs) {
  const seconds = Math.ceil((waitMs || 0) / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.ceil(seconds / 60)}m`
}

function formatTime(timestamp) {
  if (!timestamp) return '--'
  const date = new Date(timestamp)
  const hours = date.getHours() < 10 ? `0${date.getHours()}` : String(date.getHours())
  const minutes = date.getMinutes() < 10 ? `0${date.getMinutes()}` : String(date.getMinutes())
  return `${hours}:${minutes}`
}

function readNumber(key) {
  const value = Number(storage.getItem(key) || 0)
  return Number.isFinite(value) ? value : 0
}

Page(
  BasePage({
    name: 'live-dashboard.home',
    state: {
      syncing: false,
      statusText: '待机',
      lastSyncTime: 0,
      lastSyncData: '等待同步',
    },

    build() {
      this.state.lastSyncTime = readNumber('lastSyncTime')
      this.state.lastSyncData = storage.getItem('lastSyncData') || '等待同步'

      createWidget(widget.FILL_RECT, {
        x: 0,
        y: 0,
        w: DEVICE_WIDTH,
        h: DEVICE_HEIGHT,
        color: 0x101318,
      })

      createWidget(widget.TEXT, {
        x: CARD_X,
        y: TOP_Y,
        w: CARD_W,
        h: px(32),
        color: 0xf5f7fb,
        text_size: px(24),
        align_h: align.CENTER_H,
        text_style: text_style.NONE,
        text: '活动仪表板',
      })

      createWidget(widget.FILL_RECT, {
        x: CARD_X,
        y: TOP_Y + px(46),
        w: CARD_W,
        h: px(1),
        color: 0x2a3038,
      })

      createWidget(widget.TEXT, {
        x: CARD_X,
        y: TOP_Y + px(66),
        w: CARD_W,
        h: px(22),
        color: 0x8b96a6,
        text_size: px(15),
        align_h: align.CENTER_H,
        text_style: text_style.NONE,
        text: '当前心率',
      })

      this.heartRateWidget = createWidget(widget.TEXT, {
        x: CARD_X,
        y: TOP_Y + px(90),
        w: CARD_W,
        h: px(64),
        color: 0xff6b7a,
        text_size: px(52),
        align_h: align.CENTER_H,
        text_style: text_style.NONE,
        text: '--',
      })

      createWidget(widget.TEXT, {
        x: CARD_X,
        y: TOP_Y + px(154),
        w: CARD_W,
        h: px(20),
        color: 0x7c8798,
        text_size: px(13),
        align_h: align.CENTER_H,
        text_style: text_style.NONE,
        text: 'bpm',
      })

      this.statusWidget = createWidget(widget.TEXT, {
        x: CARD_X,
        y: TOP_Y + px(190),
        w: CARD_W,
        h: px(30),
        color: 0xcfd6e3,
        text_size: px(17),
        align_h: align.CENTER_H,
        text_style: text_style.WRAP,
        text: this.state.statusText,
      })

      this.lastSyncTimeWidget = createWidget(widget.TEXT, {
        x: CARD_X,
        y: TOP_Y + px(226),
        w: CARD_W,
        h: px(22),
        color: 0x8b96a6,
        text_size: px(13),
        align_h: align.CENTER_H,
        text_style: text_style.NONE,
        text: `上次 ${formatTime(this.state.lastSyncTime)}`,
      })

      this.lastSyncDataWidget = createWidget(widget.TEXT, {
        x: CARD_X,
        y: TOP_Y + px(252),
        w: CARD_W,
        h: px(42),
        color: 0x7c8798,
        text_size: px(12),
        align_h: align.CENTER_H,
        text_style: text_style.WRAP,
        text: this.state.lastSyncData,
      })

      createWidget(widget.BUTTON, {
        x: BUTTON_X,
        y: Math.min(TOP_Y + px(310), DEVICE_HEIGHT - px(112)),
        w: BUTTON_W,
        h: px(54),
        radius: px(12),
        normal_color: 0x2d7be8,
        press_color: 0x1b5fb8,
        text: '同步一次',
        text_size: px(18),
        click_func: () => this.syncOnce(true),
      })

      createWidget(widget.TEXT, {
        x: CARD_X,
        y: FOOTER_Y,
        w: CARD_W,
        h: px(18),
        color: 0x515c6b,
        text_size: px(10),
        align_h: align.CENTER_H,
        text_style: text_style.NONE,
        text: '手机中继 | 低频上传',
      })
    },

    onInit() {
      const initialHR = heartRate.getCurrent()
      if (this.heartRateWidget && initialHR > 0) {
        this.heartRateWidget.setProperty(prop.TEXT, String(initialHR))
      }
      this.syncOnce(false)
    },

    updateStatus(text) {
      this.state.statusText = text
      if (this.statusWidget) this.statusWidget.setProperty(prop.TEXT, text)
    },

    updateDisplay() {
      if (this.lastSyncTimeWidget) {
        this.lastSyncTimeWidget.setProperty(prop.TEXT, `上次 ${formatTime(this.state.lastSyncTime)}`)
      }
      if (this.lastSyncDataWidget) {
        this.lastSyncDataWidget.setProperty(prop.TEXT, this.state.lastSyncData || '等待同步')
      }
    },

    persistDisplay() {
      storage.setItem('lastSyncTime', String(this.state.lastSyncTime || 0))
      storage.setItem('lastSyncData', this.state.lastSyncData || '')
    },

    syncOnce(force) {
      if (this.state.syncing) return Promise.resolve()

      const now = Date.now()
      if (force && this.state.lastSyncTime > 0 && now - this.state.lastSyncTime < MIN_MANUAL_INTERVAL_MS) {
        this.updateStatus(`稍后再试 ${formatWait(MIN_MANUAL_INTERVAL_MS - (now - this.state.lastSyncTime))}`)
        return Promise.resolve()
      }

      const heart_rate = heartRate.getCurrent()
      if (this.heartRateWidget && heart_rate > 0) {
        this.heartRateWidget.setProperty(prop.TEXT, String(heart_rate))
      }

      this.state.syncing = true
      this.updateStatus('同步中')

      return this.request({
        method: 'watch.snapshot',
        params: {
          force,
          relay_mode: 'phone-side',
          heart_rate,
          watch_metrics: readWatchMetrics(heart_rate),
          recorded_at: now,
        },
      })
        .then((result) => {
          this.state.lastSyncTime = Date.now()
          if (result && result.skipped) {
            const wait = result.wait_ms ? ` ${formatWait(result.wait_ms)}` : ''
            this.updateStatus(`已限流${wait}`)
            this.state.lastSyncData = `跳过: ${result.reason || 'unknown'}`
          } else {
            this.updateStatus('已同步')
            this.state.lastSyncData = `心率 ${heart_rate || '--'} bpm`
          }
          this.persistDisplay()
          this.updateDisplay()
          this.state.syncing = false
        })
        .catch((error) => {
          this.state.lastSyncTime = Date.now()
          this.updateStatus('同步失败')
          this.state.lastSyncData = `错误: ${String(error).slice(0, 32)}`
          this.persistDisplay()
          this.updateDisplay()
          this.state.syncing = false
          logger.log(`Sync error: ${error}`)
        })
    },
  })
)
