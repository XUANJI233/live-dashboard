import '../models/distribution.dart';
import 'windows_bridge.dart';

class StartupService {
  const StartupService(this._bridge);

  final WindowsBridge _bridge;

  Future<bool> isEnabled(InstallScope scope, String executablePath) {
    return _bridge.isStartupEnabled(scope, executablePath);
  }

  Future<bool> setEnabled({
    required InstallScope scope,
    required String executablePath,
    required bool enabled,
  }) {
    return _bridge.setStartupEnabled(
      scope: scope,
      executablePath: executablePath,
      enabled: enabled,
    );
  }
}
