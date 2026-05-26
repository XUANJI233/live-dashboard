AppSettingsPage({
  build(props) {
    const storage = props.settingsStorage
    const get = (key, fallback) => storage.getItem(key) || fallback
    const set = (key, value) => storage.setItem(key, String(value))
    const boolSelect = (label, key, fallback) => Select({
      label,
      value: get(key, fallback),
      options: [
        { name: '开启', value: '1' },
        { name: '关闭', value: '0' },
      ],
      onChange: (value) => set(key, value),
    })

    return Section({}, [
      TextInput({
        label: '服务器地址',
        value: get('serverUrl', ''),
        placeholder: 'https://your-dashboard.example.com:9443',
        onChange: (value) => set('serverUrl', String(value || '').trim()),
      }),
      TextInput({
        label: '设备令牌',
        value: get('token', ''),
        placeholder: 'Live Dashboard token',
        onChange: (value) => set('token', String(value || '').trim()),
      }),
      Select({
        label: '中继模式',
        value: get('relayMode', 'phone-side'),
        options: [
          { name: '手机端，低功耗', value: 'phone-side' },
        ],
        onChange: (value) => set('relayMode', value),
      }),
      TextInput({
        label: '最小间隔 (毫秒)',
        value: get('minIntervalMs', '300000'),
        placeholder: '300000',
        onChange: (value) => {
          const cleaned = String(value || '').replace(/[^0-9]/g, '')
          set('minIntervalMs', cleaned || '300000')
        },
      }),
      boolSelect('心率', 'sensorHeartRate', '1'),
      boolSelect('电量', 'sensorBattery', '1'),
      boolSelect('佩戴状态', 'sensorWear', '1'),
      boolSelect('睡眠状态', 'sensorSleep', '1'),
      boolSelect('血氧', 'sensorSpo2', '1'),
      boolSelect('体温', 'sensorBodyTemp', '1'),
      boolSelect('站立', 'sensorStand', '1'),
      boolSelect('压力', 'sensorStress', '1'),
      boolSelect('步数', 'sensorStep', '0'),
      boolSelect('卡路里', 'sensorCalorie', '0'),
      boolSelect('气压/海拔', 'sensorBarometer', '0'),
    ])
  },
})
