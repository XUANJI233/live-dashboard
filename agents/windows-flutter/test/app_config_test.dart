import 'package:flutter_test/flutter_test.dart';
import 'package:live_dashboard_agent/src/models/app_config.dart';
import 'package:live_dashboard_agent/src/services/desktop_device_profile.dart';

void main() {
  test('normalizes and validates server config', () {
    final config = const AppConfig(
      serverUrl: ' https://example.com/ ',
      token: ' token ',
      intervalSeconds: 999,
      heartbeatSeconds: 1,
      idleThresholdSeconds: 2,
      enableLog: false,
    ).normalize();

    expect(config.serverUrl, 'https://example.com/');
    expect(config.token, 'token');
    expect(config.intervalSeconds, 5);
    expect(config.heartbeatSeconds, 60);
    expect(config.idleThresholdSeconds, 300);
    expect(config.validate(), isNull);
  });

  test('desktop profile uses snake case boolean capabilities', () {
    final extra = desktopDeviceProfile({});
    final device = extra['device'] as Map<String, Object?>;
    final capabilities = device['capabilities'] as Map<String, Object?>;

    expect(device['profile'], 'desktop_message');
    expect(capabilities['say'], true);
    expect(capabilities['risk_app_monitor'], false);
    expect(capabilities['app_time_limit'], false);
  });
}
