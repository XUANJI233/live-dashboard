import { TextInput, Select, Section, View } from '@zos/settings-ui'

AppSettingsPage({
  setItem(props, key, value) {
    props.settingsStorage.setItem(key, value)
  },

  build(props) {
    const serverUrl = props.settingsStorage.getItem('serverUrl') || ''
    const token = props.settingsStorage.getItem('token') || ''
    const minIntervalMs = props.settingsStorage.getItem('minIntervalMs') || '300000'
    const relayMode = props.settingsStorage.getItem('relayMode') || 'phone-side'
    const boolValue = (key, fallback = '1') => props.settingsStorage.getItem(key) || fallback
    const boolSelect = (label, key, fallback = '1') => Select({
      label,
      value: boolValue(key, fallback),
      options: [
        { name: '开启', value: '1' },
        { name: '关闭', value: '0' },
      ],
      onChange: (value) => this.setItem(props, key, value),
    })

    return View(
      {
        style: {
          padding: '12px 20px',
        },
      },
      [
        Section(
          {},
          [
            TextInput({
              label: '服务器地址',
              value: serverUrl,
              placeholder: 'https://your-dashboard.example.com:9443',
              onChange: (value) => this.setItem(props, 'serverUrl', value.trim()),
            }),
            TextInput({
              label: '设备令牌',
              value: token,
              placeholder: 'Live Dashboard token',
              onChange: (value) => this.setItem(props, 'token', value.trim()),
            }),
            Select({
              label: '中继模式',
              value: relayMode,
              options: [
                { name: '手机端，低功耗', value: 'phone-side' },
              ],
              onChange: (value) => this.setItem(props, 'relayMode', value),
            }),
            TextInput({
              label: '最小间隔 (毫秒)',
              value: minIntervalMs,
              placeholder: '300000',
              onChange: (value) => {
                const cleaned = String(value || '').replace(/[^0-9]/g, '')
                this.setItem(props, 'minIntervalMs', cleaned || '300000')
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
          ],
        ),
      ],
    )
  },
})
