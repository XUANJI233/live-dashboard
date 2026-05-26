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
import { createSysTimer, stopTimer } from '@zos/timer'
import { createWidget, widget, align, text_style, prop } from '@zos/ui'
import { log } from '@zos/utils'
import { BasePage } from '@zeppos/zml/base-page'

const logger = log.getLogger('LiveDashboardPage')
const { width: DEVICE_WIDTH, height: DEVICE_HEIGHT } = getDeviceInfo()
const storage = new LocalStorage()
const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000

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

function firstNumber(value, keys) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object') return undefined
  for (let i = 0; i < keys.length; i += 1) {
    const next = value[keys[i]]
    if (typeof next === 'number' && Number.isFinite(next)) return next
  }
  return undefined
}

function latestNumberFromList(list, keys) {
  if (!Array.isArray(list)) return undefined
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const value = firstNumber(list[i], keys)
    if (typeof value === 'number') return value
  }
  return undefined
}

function readHeartRate() {
  return readSensor(HeartRate, (sensor) => {
    const last = firstNumber(sensor.getLast && sensor.getLast(), ['heartRate', 'heart_rate', 'bpm', 'value'])
    if (last > 0) return last
    const current = firstNumber(sensor.getCurrent && sensor.getCurrent(), ['heartRate', 'heart_rate', 'bpm', 'value'])
    if (current > 0) return current
    const today = latestNumberFromList(sensor.getToday && sensor.getToday(), ['heartRate', 'heart_rate', 'bpm', 'value'])
    return today > 0 ? today : undefined
  })
}

function readBloodOxygen() {
  return readSensor(BloodOxygen, (sensor) => {
    const last = firstNumber(sensor.getLast && sensor.getLast(), ['spo2', 'oxygen', 'percentage', 'value'])
    if (last > 0) return last
    const current = firstNumber(sensor.getCurrent && sensor.getCurrent(), ['spo2', 'oxygen', 'percentage', 'value'])
    return current > 0 ? current : undefined
  })
}

function readSleepMetrics(metrics) {
  readSensor(Sleep, (sensor) => {
    const status = firstNumber(sensor.getSleepingStatus && sensor.getSleepingStatus(), ['status', 'sleepStatus', 'value'])
    if (typeof status === 'number') metrics.sleep_status = status

    const info = sensor.getInfo ? sensor.getInfo() : sensor.getSleepInfo && sensor.getSleepInfo()
    if (info && typeof info === 'object') {
      const start = firstNumber(info, ['startTime', 'start', 'sleepTime', 'beginTime'])
      const end = firstNumber(info, ['endTime', 'end', 'wakeTime'])
      const duration = firstNumber(info, ['totalTime', 'duration', 'sleepDuration', 'totalMinutes', 'minutes'])
      if (typeof start === 'number') metrics.sleep_start = start
      if (typeof end === 'number') metrics.sleep_end = end
      if (typeof duration === 'number') metrics.sleep_duration = duration
    }

    const stage = sensor.getStage ? sensor.getStage() : sensor.getStageInfo && sensor.getStageInfo()
    if (Array.isArray(stage)) {
      metrics.sleep_stage_count = stage.length
    } else if (stage && typeof stage === 'object') {
      const count = firstNumber(stage, ['count', 'length'])
      if (typeof count === 'number') metrics.sleep_stage_count = count
    }

    const nap = sensor.getNap ? sensor.getNap() : sensor.getNapInfo && sensor.getNapInfo()
    const napList = Array.isArray(nap) ? nap : nap ? [nap] : []
    if (napList.length > 0) {
      const lastNap = napList[napList.length - 1]
      const start = firstNumber(lastNap, ['startTime', 'start', 'sleepTime', 'beginTime'])
      const end = firstNumber(lastNap, ['stop', 'endTime', 'end', 'wakeTime'])
      const duration = firstNumber(lastNap, ['length', 'duration', 'sleepDuration', 'totalMinutes', 'minutes'])
      if (typeof start === 'number') metrics.nap_start = start
      if (typeof end === 'number') metrics.nap_end = end
      if (typeof duration === 'number') metrics.nap_duration = duration
    }
    return undefined
  })
}

function readWatchMetrics(heart_rate) {
  const metrics = {}
  if (heart_rate > 0) metrics.heart_rate = heart_rate

  const battery = readSensor(Battery, (sensor) => sensor.getCurrent())
  if (typeof battery === 'number') metrics.battery_percent = battery

  const wear = readSensor(Wear, (sensor) => sensor.getStatus())
  if (typeof wear === 'number') metrics.wear_status = wear

  readSleepMetrics(metrics)

  const spo2 = readBloodOxygen()
  if (spo2 > 0) metrics.spo2 = spo2

  const temp = readSensor(BodyTemperature, (sensor) => sensor.getCurrent())
  const tempValue = firstNumber(temp, ['current', 'temperature', 'value'])
  if (typeof tempValue === 'number' && tempValue > -100) metrics.body_temperature = tempValue

  const stand = readSensor(Stand, (sensor) => ({
    current: sensor.getCurrent && sensor.getCurrent(),
    target: sensor.getTarget && sensor.getTarget(),
  }))
  if (stand) {
    const current = firstNumber(stand.current, ['current', 'count', 'value'])
    const target = firstNumber(stand.target, ['target', 'count', 'value'])
    if (typeof current === 'number') metrics.stand_count = current
    if (typeof target === 'number') metrics.stand_target = target
  }

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
      this.autoTimerId = null
      const initialHR = readHeartRate()
      if (this.heartRateWidget && initialHR > 0) {
        this.heartRateWidget.setProperty(prop.TEXT, String(initialHR))
      }
      this.syncOnce(false)
      this.autoTimerId = createSysTimer(true, AUTO_SYNC_INTERVAL_MS, () => this.syncOnce(false))
    },

    onDestroy() {
      if (this.autoTimerId != null) {
        stopTimer(this.autoTimerId)
        this.autoTimerId = null
      }
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

      const heart_rate = readHeartRate()
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
            this.state.lastSyncData = `先不传: ${result.reason || '还不知道原因'}`
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
