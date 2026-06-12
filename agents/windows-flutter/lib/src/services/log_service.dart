import 'dart:io';

import '../models/app_config.dart';
import 'windows_bridge.dart';

class LogService {
  LogService(this._bridge);

  final WindowsBridge _bridge;
  String? _logDirectory;

  Future<String> get logDirectory async {
    if (_logDirectory case final cached?) {
      return cached;
    }
    final paths = await _bridge.getPaths();
    final directory = (paths['log_directory'] as String?) ?? '';
    _logDirectory = directory;
    return directory;
  }

  Future<String> get logPath async => '${await logDirectory}\\agent.log';

  Future<void> write(AppConfig config, String message) async {
    if (!config.enableLog) {
      return;
    }
    try {
      final directory = Directory(await logDirectory);
      await directory.create(recursive: true);
      final file = File(await logPath);
      if (await file.exists() && await file.length() > 1024 * 1024) {
        await file.rename('${file.path}.1');
      }
      await file.writeAsString(
        '${DateTime.now().toUtc().toIso8601String()} $message${Platform.lineTerminator}',
        mode: FileMode.append,
        flush: false,
      );
    } catch (_) {
      // Logging must never disturb the resident runtime loop.
    }
  }

  Future<void> openLogFolder() async {
    final directory = Directory(await logDirectory);
    await directory.create(recursive: true);
    await _bridge.openPath(directory.path);
  }

  Future<void> openLogFile() async {
    final file = File(await logPath);
    await file.parent.create(recursive: true);
    if (!await file.exists()) {
      await file.writeAsString('');
    }
    await _bridge.openPath(file.path);
  }
}
