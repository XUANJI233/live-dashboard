// ────────────────────────────────────────────
//  Live Watch — Settings App (runs in Zepp mobile app)
//
//  用户通过此界面配置服务器地址、Token 和传感器选项
//  配置存储在 settingsStorage，side-service 和 page 均可读取
//
//  参考：https://docs.zepp.com/zh-cn/docs/reference/app-settings-api/
// ────────────────────────────────────────────

import { TextInput, Toggle, Section, View } from '@zos/settings-ui'

AppSettingsPage({
  build(props) {
    const storage = props.settingsStorage
    const get = (key, fallback) => storage.getItem(key) || fallback
    const set = (key, value) => storage.setItem(key, String(value))

    // 布尔值 → '1'/'0' 字符串
    const boolToStr = (b) => b ? '1' : '0'
    const strToBool = (s) => s === '1' || s === true

    // 辅助函数：Toggle 开关（替代 Select）
    const toggleSwitch = (label, key, fallback) => Toggle({
      label,
      value: strToBool(get(key, boolToStr(fallback))),
      onChange: (value) => set(key, boolToStr(value)),
    })

    return Section({}, [
      // ── 服务器配置 ──
      TextInput({
        label: '服务器地址',
        value: get('serverUrl', ''),
        placeholder: 'https://your-dashboard.example.com',
        onChange: (value) => set('serverUrl', String(value || '').trim()),
      }),
      TextInput({
        label: '设备令牌',
        value: get('token', ''),
        placeholder: 'Bearer Token',
        onChange: (value) => set('token', String(value || '').trim()),
      }),
      TextInput({
        label: '同步间隔 (秒)',
        value: get('syncInterval', '300'),
        placeholder: '60-3600',
        onChange: (value) => {
          const cleaned = String(value || '').replace(/[^0-9]/g, '')
          const interval = Math.max(60, Math.min(3600, parseInt(cleaned) || 300))
          set('syncInterval', String(interval))
        },
      }),

      // ── 启用开关 ──
      toggleSwitch('启用同步', 'enabled', true),

      // ── 传感器配置 ──
      View({
        style: { marginTop: '16px' },
      }, [
        Toggle({
          label: '心率',
          value: strToBool(get('sensorHeartRate', '1')),
          onChange: (value) => set('sensorHeartRate', boolToStr(value)),
        }),
        Toggle({
          label: '电量',
          value: strToBool(get('sensorBattery', '1')),
          onChange: (value) => set('sensorBattery', boolToStr(value)),
        }),
        Toggle({
          label: '步数',
          value: strToBool(get('sensorStep', '1')),
          onChange: (value) => set('sensorStep', boolToStr(value)),
        }),
        Toggle({
          label: '睡眠状态',
          value: strToBool(get('sensorSleep', '1')),
          onChange: (value) => set('sensorSleep', boolToStr(value)),
        }),
        Toggle({
          label: '体表温度',
          value: strToBool(get('sensorBodyTemp', '1')),
          onChange: (value) => set('sensorBodyTemp', boolToStr(value)),
        }),
        Toggle({
          label: '血氧',
          value: strToBool(get('sensorSpo2', '0')),
          onChange: (value) => set('sensorSpo2', boolToStr(value)),
        }),
        Toggle({
          label: '压力',
          value: strToBool(get('sensorStress', '0')),
          onChange: (value) => set('sensorStress', boolToStr(value)),
        }),
      ]),
    ])
  },
})
