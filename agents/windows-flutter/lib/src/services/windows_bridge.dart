import 'package:flutter/services.dart';

import '../models/distribution.dart';

class WindowsBridge {
  static const _channel = MethodChannel('live_dashboard_agent/windows');

  Future<Map<Object?, Object?>> readConfig() async {
    final result = await _channel.invokeMethod<Map<Object?, Object?>>(
      'readConfig',
    );
    return result ?? <Object?, Object?>{};
  }

  Future<void> writeConfig(Map<String, Object?> config) {
    return _channel.invokeMethod('writeConfig', config);
  }

  Future<Map<Object?, Object?>> getPaths() async {
    final result = await _channel.invokeMethod<Map<Object?, Object?>>(
      'getPaths',
    );
    return result ?? <Object?, Object?>{};
  }

  Future<Map<Object?, Object?>> probeActivity() async {
    final result = await _channel.invokeMethod<Map<Object?, Object?>>(
      'probeActivity',
    );
    return result ?? <Object?, Object?>{};
  }

  Future<bool> isStartupEnabled(
    InstallScope scope,
    String executablePath,
  ) async {
    return await _channel.invokeMethod<bool>('isStartupEnabled', {
          'scope': scope.registryValue,
          'executable_path': executablePath,
        }) ??
        false;
  }

  Future<bool> setStartupEnabled({
    required InstallScope scope,
    required String executablePath,
    required bool enabled,
  }) async {
    return await _channel.invokeMethod<bool>('setStartupEnabled', {
          'scope': scope.registryValue,
          'executable_path': executablePath,
          'enabled': enabled,
        }) ??
        false;
  }

  Future<bool> isAdministrator() async {
    return await _channel.invokeMethod<bool>('isAdministrator') ?? false;
  }

  Future<String?> selectInstallParentDirectory() {
    return _channel.invokeMethod<String>('selectInstallParentDirectory');
  }

  Future<String> sha256File(String path) async {
    return await _channel.invokeMethod<String>('sha256File', {'path': path}) ??
        '';
  }

  Future<void> setHideToTray(bool enabled) {
    return _channel.invokeMethod('setHideToTray', {'enabled': enabled});
  }

  Future<void> showMainWindow() {
    return _channel.invokeMethod('showMainWindow');
  }

  Future<void> openPath(String path) {
    return _channel.invokeMethod('openPath', {'path': path});
  }

  Future<void> launchProcess(String path, List<String> arguments) {
    return _channel.invokeMethod('launchProcess', {
      'path': path,
      'arguments': arguments,
    });
  }

  Future<bool> createDesktopShortcut(String executablePath) async {
    return await _channel.invokeMethod<bool>('createDesktopShortcut', {
          'executable_path': executablePath,
        }) ??
        false;
  }
}
