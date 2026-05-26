AppSettingsPage({
  setItem(props, key, value) {
    props.settingsStorage.setItem(key, value)
  },

  build(props) {
    const serverUrl = props.settingsStorage.getItem('serverUrl') || ''
    const token = props.settingsStorage.getItem('token') || ''
    const minIntervalMs = props.settingsStorage.getItem('minIntervalMs') || '300000'
    const relayMode = props.settingsStorage.getItem('relayMode') || 'phone-side'

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
              label: 'Server URL',
              value: serverUrl,
              placeholder: 'https://your-dashboard.example.com',
              onChange: (value) => this.setItem(props, 'serverUrl', value.trim()),
            }),
            TextInput({
              label: 'Device token',
              value: token,
              placeholder: 'Live Dashboard token',
              onChange: (value) => this.setItem(props, 'token', value.trim()),
            }),
            Select({
              label: 'Relay mode',
              value: relayMode,
              options: [
                { name: 'Phone side, low power', value: 'phone-side' },
              ],
              onChange: (value) => this.setItem(props, 'relayMode', value),
            }),
            TextInput({
              label: 'Minimum interval (ms)',
              value: minIntervalMs,
              placeholder: '300000',
              onChange: (value) => {
                const cleaned = String(value || '').replace(/[^0-9]/g, '')
                this.setItem(props, 'minIntervalMs', cleaned || '300000')
              },
            }),
          ],
        ),
      ],
    )
  },
})
