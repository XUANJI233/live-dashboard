import '../models/app_config.dart';
import 'windows_bridge.dart';

class ConfigStore {
  const ConfigStore(this._bridge);

  final WindowsBridge _bridge;

  Future<AppConfig> load() async {
    final raw = await _bridge.readConfig();
    return AppConfig.fromMap(raw);
  }

  Future<void> save(AppConfig config) {
    return _bridge.writeConfig(config.normalize().toRegistryMap());
  }
}
