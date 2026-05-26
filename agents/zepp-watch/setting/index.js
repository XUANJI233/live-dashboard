const DEFAULTS = {
  serverUrl: '',
  token: '',
  relayMode: 'phone-side',
  minIntervalMs: '300000',
  sensorHeartRate: '1',
  sensorBattery: '1',
  sensorWear: '1',
  sensorSleep: '1',
  sensorSpo2: '1',
  sensorBodyTemp: '1',
  sensorStand: '1',
  sensorStress: '1',
  sensorStep: '0',
  sensorCalorie: '0',
  sensorBarometer: '0',
}

function cleanInterval(value) {
  const cleaned = String(value || '').replace(/[^0-9]/g, '')
  return cleaned || DEFAULTS.minIntervalMs
}

AppSettingsPage({
  state: {
    draft: {},
    saved: false,
  },

  loadDraft(props) {
    const storage = props.settingsStorage
    const draft = {}
    Object.keys(DEFAULTS).forEach((key) => {
      draft[key] = storage.getItem(key) || DEFAULTS[key]
    })
    this.state.draft = draft
  },

  setDraft(key, value) {
    this.state.draft = {
      ...this.state.draft,
      [key]: String(value || ''),
    }
    this.state.saved = false
  },

  save(props) {
    const storage = props.settingsStorage
    const draft = this.state.draft
    Object.keys(DEFAULTS).forEach((key) => {
      storage.setItem(key, key === 'minIntervalMs' ? cleanInterval(draft[key]) : String(draft[key] || DEFAULTS[key]))
    })
    this.state.saved = true
  },

  boolSelect(label, key) {
    return Select({
      label,
      value: this.state.draft[key] || DEFAULTS[key],
      options: [
        { name: '开启', value: '1' },
        { name: '关闭', value: '0' },
      ],
      onChange: (value) => this.setDraft(key, value),
    })
  },

  build(props) {
    if (!this.state.draft.serverUrl) this.loadDraft(props)

    return Section({}, [
      TextInput({
        label: '服务器地址',
        value: this.state.draft.serverUrl,
        placeholder: 'https://your-dashboard.example.com:9443',
        onChange: (value) => this.setDraft('serverUrl', String(value || '').trim()),
      }),
      TextInput({
        label: '设备令牌',
        value: this.state.draft.token,
        placeholder: 'Live Dashboard token',
        onChange: (value) => this.setDraft('token', String(value || '').trim()),
      }),
      Select({
        label: '中继模式',
        value: this.state.draft.relayMode || DEFAULTS.relayMode,
        options: [
          { name: '手机端，低功耗', value: 'phone-side' },
        ],
        onChange: (value) => this.setDraft('relayMode', value),
      }),
      TextInput({
        label: '最小间隔 (毫秒)',
        value: this.state.draft.minIntervalMs,
        placeholder: DEFAULTS.minIntervalMs,
        onChange: (value) => this.setDraft('minIntervalMs', cleanInterval(value)),
      }),
      this.boolSelect('心率', 'sensorHeartRate'),
      this.boolSelect('电量', 'sensorBattery'),
      this.boolSelect('佩戴状态', 'sensorWear'),
      this.boolSelect('睡眠状态', 'sensorSleep'),
      this.boolSelect('血氧', 'sensorSpo2'),
      this.boolSelect('体温', 'sensorBodyTemp'),
      this.boolSelect('站立', 'sensorStand'),
      this.boolSelect('压力', 'sensorStress'),
      this.boolSelect('步数', 'sensorStep'),
      this.boolSelect('卡路里', 'sensorCalorie'),
      this.boolSelect('气压/海拔', 'sensorBarometer'),
      Button({
        label: this.state.saved ? '已保存' : '保存设置',
        color: 'primary',
        style: {
          borderRadius: '24px',
          marginTop: '12px',
        },
        onClick: () => this.save(props),
      }),
    ])
  },
})
