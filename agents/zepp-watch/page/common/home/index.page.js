import { HeartRate } from '@zos/sensor'
import { createWidget, widget, align, text_style, prop } from '@zos/ui'
import { log } from '@zos/utils'

const heartRate = new HeartRate()

function formatWait(waitMs) {
  const seconds = Math.ceil((waitMs || 0) / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  return `${Math.ceil(seconds / 60)}m`
}

function formatTime(timestamp) {
  if (!timestamp) return '--'
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

Page({
  statusWidget: null,
  lastSyncTimeWidget: null,
  lastSyncDataWidget: null,
  heartRateWidget: null,
  statusText: '就绪',
  lastSyncTime: 0,
  lastSyncData: '',

  build() {
    // Background
    createWidget(widget.RECT, {
      x: 0,
      y: 0,
      w: 480,
      h: 480,
      color: 0x1a1a1a,
      radius: 0,
    })

    // Title
    createWidget(widget.TEXT, {
      x: 24,
      y: 16,
      w: 432,
      h: 40,
      color: 0xffffff,
      text_size: 28,
      align_h: align.CENTER_H,
      text_style: text_style.NONE,
      text: '❤️ 活动仪表板',
    })

    // Divider line
    createWidget(widget.RECT, {
      x: 24,
      y: 60,
      w: 432,
      h: 1,
      color: 0x404040,
      radius: 0,
    })

    // Heart rate display (large)
    this.heartRateWidget = createWidget(widget.TEXT, {
      x: 24,
      y: 75,
      w: 432,
      h: 60,
      color: 0xff6b6b,
      text_size: 48,
      align_h: align.CENTER_H,
      text_style: text_style.NONE,
      text: '--',
    })

    // BPM label
    createWidget(widget.TEXT, {
      x: 24,
      y: 138,
      w: 432,
      h: 20,
      color: 0x888888,
      text_size: 12,
      align_h: align.CENTER_H,
      text_style: text_style.NONE,
      text: '次/分',
    })

    // Status
    this.statusWidget = createWidget(widget.TEXT, {
      x: 24,
      y: 165,
      w: 432,
      h: 35,
      color: 0xcccccc,
      text_size: 16,
      align_h: align.CENTER_H,
      text_style: text_style.WRAP,
      text: this.statusText,
    })

    // Last sync time
    this.lastSyncTimeWidget = createWidget(widget.TEXT, {
      x: 24,
      y: 205,
      w: 432,
      h: 24,
      color: 0x999999,
      text_size: 12,
      align_h: align.CENTER_H,
      text_style: text_style.NONE,
      text: `上次: ${formatTime(this.lastSyncTime)}`,
    })

    // Last sync data
    this.lastSyncDataWidget = createWidget(widget.TEXT, {
      x: 24,
      y: 232,
      w: 432,
      h: 35,
      color: 0x666666,
      text_size: 11,
      align_h: align.CENTER_H,
      text_style: text_style.WRAP,
      text: `${this.lastSyncData || '未同步'}`,
    })

    // Sync button
    createWidget(widget.BUTTON, {
      x: 60,
      y: 285,
      w: 360,
      h: 54,
      radius: 12,
      normal_color: 0x2f7dd1,
      press_color: 0x1f5fa8,
      text: '🔄 立即同步',
      text_size: 18,
      click_func: () => this.syncOnce(true),
    })

    // Footer info
    createWidget(widget.TEXT, {
      x: 24,
      y: 450,
      w: 432,
      h: 18,
      color: 0x555555,
      text_size: 10,
      align_h: align.CENTER_H,
      text_style: text_style.NONE,
      text: 'v0.1.0',
    })
  },

  onInit() {
    // Show initial heart rate
    const initialHR = heartRate.getCurrent()
    if (this.heartRateWidget && initialHR > 0) {
      this.heartRateWidget.setProperty(prop.TEXT, String(initialHR))
    }
    this.syncOnce(false)
  },

  updateStatus(text) {
    this.statusText = text
    if (this.statusWidget) {
      this.statusWidget.setProperty(prop.TEXT, text)
    }
  },

  updateDisplay() {
    if (this.lastSyncTimeWidget) {
      this.lastSyncTimeWidget.setProperty(prop.TEXT, `上次: ${formatTime(this.lastSyncTime)}`)
    }
    if (this.lastSyncDataWidget) {
      this.lastSyncDataWidget.setProperty(prop.TEXT, this.lastSyncData || '未同步')
    }
  },

  syncOnce(force) {
    const heart_rate = heartRate.getCurrent()
    
    // Update heart rate display
    if (this.heartRateWidget && heart_rate > 0) {
      this.heartRateWidget.setProperty(prop.TEXT, String(heart_rate))
    }
    
    this.updateStatus('同步中...')
    
    return request({
      method: 'watch.snapshot',
      params: {
        force,
        relay_mode: 'phone-side',
        heart_rate,
        recorded_at: Date.now(),
      },
    })
      .then((result) => {
        const now = Date.now()
        this.lastSyncTime = now
        
        if (result?.skipped) {
          const wait = result.wait_ms ? ` ${formatWait(result.wait_ms)}` : ''
          this.updateStatus(`速率限制${wait}`)
          this.lastSyncData = `⏸️ 跳过 (${result.reason || 'unknown'})`
        } else {
          this.updateStatus(`✓ 已同步`)
          this.lastSyncData = `心率: ${heart_rate || '--'} bpm`
        }
        this.updateDisplay()
      })
      .catch((error) => {
        const now = Date.now()
        this.lastSyncTime = now
        this.updateStatus(`✗ 同步失败`)
        this.lastSyncData = `错误: ${String(error).substring(0, 30)}`
        this.updateDisplay()
        log(`Sync error: ${error}`)
      })
  },
})
