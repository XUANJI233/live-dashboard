// ────────────────────────────────────────────
//  Live Watch — Settings App (runs in Zepp mobile app)
//
//  用户通过此界面配置服务器地址、Token 和传感器选项
//  配置存储在 settingsStorage，side-service 和 page 均可读取
//
//  参考：https://docs.zepp.com/zh-cn/docs/reference/app-settings-api/
// ────────────────────────────────────────────

// Note: TextInput, Toggle, Section, View are globally available in Zepp OS settings page
// context — do NOT import from @zos/settings-ui (causes white screen)

AppSettingsPage({
  build(props) {
    const storage = props.settingsStorage

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

    return Section({}, [
      // ── 服务器配置 ──
      TextInput({
        label: '服务器地址',
        value: get('serverUrl', ''),
        placeholder: 'https://your-dashboard.example.com',
        onChange: (value) => writeConfig({ serverUrl: String(value || '').trim() }),
      }),
      TextInput({
        label: '设备令牌',
        value: get('token', ''),
        placeholder: 'Bearer Token',
        onChange: (value) => writeConfig({ token: String(value || '').trim() }),
      }),
      TextInput({
        label: '同步间隔 (秒)',
        value: String(get('syncInterval', 300)),
        placeholder: '60-3600',
        onChange: (value) => {
          const cleaned = String(value || '').replace(/[^0-9]/g, '')
          const interval = Math.max(60, Math.min(3600, parseInt(cleaned) || 300))
          writeConfig({ syncInterval: interval })
        },
      }),

      // ── 启用开关 ──
      Toggle({
        label: '启用同步',
        value: Boolean(get('enabled', true)),
        onChange: (value) => writeConfig({ enabled: Boolean(value) }),
      }),

      // ── 传感器配置 ──
      View({
        style: { marginTop: '16px' },
      }, [
        Toggle({
          label: '心率',
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
        }),
      ]),
    ])
  },
})
