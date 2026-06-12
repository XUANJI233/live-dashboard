import 'config_store.dart';
import 'installer_service.dart';
import 'log_service.dart';
import 'message_history_store.dart';
import 'runtime_service.dart';
import 'startup_service.dart';
import 'windows_bridge.dart';

class AppServices {
  AppServices({
    required this.bridge,
    required this.configStore,
    required this.logService,
    required this.messageHistory,
    required this.runtime,
    required this.startup,
    required this.installer,
  });

  final WindowsBridge bridge;
  final ConfigStore configStore;
  final LogService logService;
  final MessageHistoryStore messageHistory;
  final RuntimeService runtime;
  final StartupService startup;
  final InstallerService installer;

  factory AppServices.create() {
    final bridge = WindowsBridge();
    final logService = LogService(bridge);
    final messageHistory = MessageHistoryStore();
    final startup = StartupService(bridge);
    return AppServices(
      bridge: bridge,
      configStore: ConfigStore(bridge),
      logService: logService,
      messageHistory: messageHistory,
      runtime: RuntimeService(
        bridge: bridge,
        logService: logService,
        messageHistory: messageHistory,
      ),
      startup: startup,
      installer: InstallerService(bridge: bridge, startup: startup),
    );
  }
}
