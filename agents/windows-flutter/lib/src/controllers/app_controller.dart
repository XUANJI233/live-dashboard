import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/app_config.dart';
import '../models/device_message.dart';
import '../models/distribution.dart';
import '../models/install_state.dart';
import '../models/runtime_snapshot.dart';
import '../services/app_services.dart';
import '../services/install_directory_safety.dart';
import '../services/installer_service.dart';

class AppController extends ChangeNotifier {
  AppController(this._services);

  final AppServices _services;
  StreamSubscription<RuntimeSnapshot>? _runtimeSubscription;
  AppConfig _config = const AppConfig.empty();
  RuntimeSnapshot _runtime = const RuntimeSnapshot.stopped();
  InstallState _installState = const InstallState.initial();
  String _baseDirectory = '';
  String _executablePath = '';
  bool _startupEnabled = false;
  bool _initialized = false;

  AppConfig get config => _config;
  RuntimeSnapshot get runtime => _runtime;
  InstallState get installState => _installState;
  List<DeviceMessage> get messages => _services.messageHistory.items;
  bool get startupEnabled => _startupEnabled;
  bool get initialized => _initialized;
  String get baseDirectory => _baseDirectory;
  String get executablePath => _executablePath;

  Future<void> initialize() async {
    _runtimeSubscription = _services.runtime.snapshots.listen((snapshot) {
      _runtime = snapshot;
      notifyListeners();
    });
    _config = await _services.configStore.load();
    final paths = await _services.bridge.getPaths();
    _baseDirectory = (paths['base_directory'] as String?) ?? '';
    _executablePath = (paths['executable_path'] as String?) ?? '';
    final runningInstallScope = await _services.installer.runningInstallScope();
    final runningInstall = runningInstallScope != null;
    final defaultDir = await _services.installer.defaultDirectory(
      InstallScope.currentUser,
    );
    _installState = _installState.copyWith(
      installDirectory: runningInstall ? _baseDirectory : defaultDir,
      scope: runningInstallScope ?? InstallScope.currentUser,
      isRunningFromRegisteredInstall: runningInstall,
    );
    _startupEnabled = await _services.startup.isEnabled(
      _installState.scope,
      _executablePath,
    );
    _initialized = true;
    notifyListeners();
    await _services.bridge.setHideToTray(true);
    if (_config.validate() == null) {
      await refreshMessages();
      _services.runtime.start(_config);
    }
  }

  Future<void> saveConfig(AppConfig config) async {
    _config = config.normalize();
    await _services.configStore.save(_config);
    notifyListeners();
    _services.runtime.restart(_config);
  }

  Future<void> toggleStartup(bool enabled) async {
    final ok = await _services.startup.setEnabled(
      scope: _installState.scope,
      executablePath: _executablePath,
      enabled: enabled,
    );
    _startupEnabled = ok && enabled;
    notifyListeners();
  }

  Future<void> refreshMessages() async {
    await _services.runtime.loadHistory(_config);
    notifyListeners();
  }

  Future<void> openLogs() => _services.logService.openLogFolder();
  Future<void> openLogFile() => _services.logService.openLogFile();

  Future<void> chooseInstallFolder() async {
    final folder = await _services.bridge.selectInstallParentDirectory();
    if (folder == null || folder.trim().isEmpty) {
      return;
    }
    _installState = _installState.copyWith(
      installDirectory: InstallDirectorySafety.directoryInsideSelectedFolder(
        folder,
      ),
      lastMessage: '',
    );
    notifyListeners();
  }

  void setInstallScope(InstallScope scope) {
    _installState = _installState.copyWith(scope: scope, lastMessage: '');
    unawaited(_refreshDefaultInstallDirectory(scope));
    notifyListeners();
  }

  void setInstallDirectory(String value) {
    _installState = _installState.copyWith(
      installDirectory: value,
      lastMessage: '',
    );
    notifyListeners();
  }

  Future<void> install({
    required bool createDesktopShortcut,
    required bool launchAfterInstall,
  }) async {
    await _runInstallAction(() {
      return _services.installer.install(
        installDirectory: _installState.installDirectory,
        scope: _installState.scope,
        createDesktopShortcut: createDesktopShortcut,
        launchAfterInstall: launchAfterInstall,
      );
    });
  }

  Future<void> uninstall({required bool removeLogs}) async {
    await _runInstallAction(() {
      return _services.installer.uninstall(
        installDirectory: _installState.installDirectory,
        scope: _installState.scope,
        removeLogs: removeLogs,
      );
    });
  }

  Future<void> uninstallCurrentInstall({required bool removeLogs}) async {
    await _runInstallAction(() {
      return _services.installer.uninstall(
        installDirectory: _baseDirectory,
        scope: _installState.scope,
        removeLogs: removeLogs,
      );
    });
  }

  Future<void> _runInstallAction(
    Future<InstallResult> Function() action,
  ) async {
    _installState = _installState.copyWith(isBusy: true, lastMessage: '');
    notifyListeners();
    try {
      final result = await action();
      _installState = _installState.copyWith(
        isBusy: false,
        installDirectory: result.installDirectory,
        lastMessage: result.message,
        isRunningFromRegisteredInstall:
            _installState.isRunningFromRegisteredInstall || result.ok,
      );
    } catch (error) {
      _installState = _installState.copyWith(
        isBusy: false,
        lastMessage: error.toString(),
      );
    }
    notifyListeners();
  }

  Future<void> _refreshDefaultInstallDirectory(InstallScope scope) async {
    final current = _installState.installDirectory;
    final currentUser = await _services.installer.defaultDirectory(
      InstallScope.currentUser,
    );
    final allUsers = await _services.installer.defaultDirectory(
      InstallScope.allUsers,
    );
    if (current == currentUser || current == allUsers || current.isEmpty) {
      _installState = _installState.copyWith(
        installDirectory: await _services.installer.defaultDirectory(scope),
      );
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _runtimeSubscription?.cancel();
    _services.runtime.dispose();
    super.dispose();
  }
}
