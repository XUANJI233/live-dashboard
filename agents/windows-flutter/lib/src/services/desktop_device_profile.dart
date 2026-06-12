Map<String, Object?> desktopDeviceProfile(Map<String, Object?> extra) {
  return {
    ...extra,
    'device': {
      'profile': 'desktop_message',
      'device_kind': 'windows',
      'last_sample_at': DateTime.now().toUtc().toIso8601String(),
      'capabilities': {
        'freeze': false,
        'unfreeze': false,
        'vibrate': false,
        'screen_off': false,
        'say': true,
        'risk_app_monitor': false,
        'app_time_limit': false,
      },
    },
  };
}
