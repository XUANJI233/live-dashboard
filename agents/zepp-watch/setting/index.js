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
<<<<<<< Updated upstream
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
=======

    // Read/write single JSON blob — matches side-service onSettingsChange('livewatch_config', ...)
    const readConfig = () => {
      try {
        const raw = storage.getItem('livewatch_config')
        return raw ? JSON.parse(raw) : {}
      } catch (e) {
        return {}
      }
    }
    const writeConfig = (patch) => {
      const cfg = { ...readConfig(), ...patch }
      storage.setItem('livewatch_config', JSON.stringify(cfg))
    }
    const get = (key, fallback) => {
      const cfg = readConfig()
      return cfg[key] !== undefined ? cfg[key] : fallback
    }
>>>>>>> Stashed changes

    return Section({}, [
      // ── 服务器配置 ──
      TextInput({
        label: '服务器地址',
        value: get('serverUrl', ''),
        placeholder: 'https://your-dashboard.example.com',
<<<<<<< Updated upstream
        onChange: (value) => set('serverUrl', String(value || '').trim()),
=======
        onChange: (value) => writeConfig({ serverUrl: String(value || '').trim() }),
>>>>>>> Stashed changes
      }),
      TextInput({
        label: '设备令牌',
        value: get('token', ''),
        placeholder: 'Bearer Token',
<<<<<<< Updated upstream
        onChange: (value) => set('token', String(value || '').trim()),
      }),
      TextInput({
        label: '同步间隔 (秒)',
        value: get('syncInterval', '300'),
=======
        onChange: (value) => writeConfig({ token: String(value || '').trim() }),
      }),
      TextInput({
        label: '同步间隔 (秒)',
        value: String(get('syncInterval', 300)),
>>>>>>> Stashed changes
        placeholder: '60-3600',
        onChange: (value) => {
          const cleaned = String(value || '').replace(/[^0-9]/g, '')
          const interval = Math.max(60, Math.min(3600, parseInt(cleaned) || 300))
<<<<<<< Updated upstream
          set('syncInterval', String(interval))
=======
          writeConfig({ syncInterval: interval })
>>>>>>> Stashed changes
        },
      }),

      // ── 启用开关 ──
<<<<<<< Updated upstream
      toggleSwitch('启用同步', 'enabled', true),
=======
      Toggle({
        label: '启用同步',
        value: Boolean(get('enabled', true)),
        onChange: (value) => writeConfig({ enabled: Boolean(value) }),
      }),
>>>>>>> Stashed changes

      // ── 传感器配置 ──
      View({
        style: { marginTop: '16px' },
      }, [
        Toggle({
          label: '心率',
<<<<<<< Updated upstream
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
=======
          value: Boolean(get('sensorHeartRate', true)),
          onChange: (value) => writeConfig({ sensorHeartRate: Boolean(value) }),
        }),
        Toggle({
          label: '电量',
          value: Boolean(get('sensorBattery', true)),
          onChange: (value) => writeConfig({ sensorBattery: Boolean(value) }),
        }),
        Toggle({
          label: '步数',
          value: Boolean(get('sensorStep', true)),
          onChange: (value) => writeConfig({ sensorStep: Boolean(value) }),
        }),
        Toggle({
          label: '睡眠状态',
          value: Boolean(get('sensorSleep', true)),
          onChange: (value) => writeConfig({ sensorSleep: Boolean(value) }),
        }),
        Toggle({
          label: '体表温度',
          value: Boolean(get('sensorBodyTemp', true)),
          onChange: (value) => writeConfig({ sensorBodyTemp: Boolean(value) }),
        }),
        Toggle({
          label: '血氧',
          value: Boolean(get('sensorSpo2', false)),
          onChange: (value) => writeConfig({ sensorSpo2: Boolean(value) }),
        }),
        Toggle({
          label: '压力',
          value: Boolean(get('sensorStress', false)),
          onChange: (value) => writeConfig({ sensorStress: Boolean(value) }),
>>>>>>> Stashed changes
        }),
      ]),
    ])
  },
})
