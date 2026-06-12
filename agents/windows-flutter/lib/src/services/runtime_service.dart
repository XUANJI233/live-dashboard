import 'dart:async';

import '../models/app_config.dart';
import '../models/device_message.dart';
import '../models/runtime_snapshot.dart';
import 'desktop_device_profile.dart';
import 'device_command_executor.dart';
import 'device_message_client.dart';
import 'log_service.dart';
import 'message_history_store.dart';
import 'report_client.dart';
import 'windows_bridge.dart';

class RuntimeService {
  RuntimeService({
    required WindowsBridge bridge,
    required LogService logService,
    required MessageHistoryStore messageHistory,
  }) : _bridge = bridge,
       _logService = logService,
       _messageHistory = messageHistory;

  final WindowsBridge _bridge;
  final LogService _logService;
  final MessageHistoryStore _messageHistory;
  final DeviceCommandExecutor _commandExecutor = const DeviceCommandExecutor();
  final _snapshotController = StreamController<RuntimeSnapshot>.broadcast();
  Timer? _timer;
  int _generation = 0;
  AppConfig _config = const AppConfig.empty();
  RuntimeSnapshot _snapshot = const RuntimeSnapshot.stopped();
  ReportClient? _reportClient;
  DeviceMessageClient? _messageClient;
  DateTime _lastReportAt = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
  DateTime _lastMessageFetchAt = DateTime.fromMillisecondsSinceEpoch(
    0,
    isUtc: true,
  );
  Map<String, String>? _previousTarget;
  bool _wasIdle = false;

  RuntimeSnapshot get snapshot => _snapshot;
  Stream<RuntimeSnapshot> get snapshots => _snapshotController.stream;

  void start(AppConfig config) {
    stop();
    final normalized = config.normalize();
    final validation = normalized.validate();
    if (validation != null) {
      _setSnapshot(
        RuntimeSnapshot(
          status: '配置未完成',
          currentTarget: '暂无窗口',
          lastReportAt: null,
          lastError: validation,
          isRunning: false,
        ),
      );
      return;
    }
    _config = normalized;
    _reportClient = ReportClient(normalized);
    _messageClient = DeviceMessageClient(normalized);
    _setSnapshot(
      const RuntimeSnapshot(
        status: '启动中',
        currentTarget: '暂无窗口',
        lastReportAt: null,
        lastError: '',
        isRunning: true,
      ),
    );
    unawaited(_logService.write(normalized, 'runtime starting'));
    _scheduleNext(Duration.zero, _generation);
  }

  void restart(AppConfig config) {
    start(config);
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
    _generation += 1;
    _reportClient?.close();
    _messageClient?.close();
    _reportClient = null;
    _messageClient = null;
    if (_snapshot.isRunning) {
      _setSnapshot(_snapshot.copyWith(status: '已停止', isRunning: false));
    }
  }

  Future<void> loadHistory(AppConfig config) async {
    final validation = config.normalize().validate();
    if (validation != null) {
      return;
    }
    final client = DeviceMessageClient(config);
    try {
      _messageHistory.replaceAll(await client.fetchHistory());
    } finally {
      client.close();
    }
  }

  Future<void> _tick() async {
    final generation = _generation;
    if (!_snapshot.isRunning) {
      return;
    }
    try {
      final reporter = _reportClient;
      final messages = _messageClient;
      if (reporter == null || messages == null) {
        return;
      }
      final now = DateTime.now().toUtc();
      if (now.difference(_lastMessageFetchAt) >= const Duration(seconds: 30)) {
        await _fetchPendingMessages(messages);
        _lastMessageFetchAt = now;
      }

      final probe = await _bridge.probeActivity();
      final idleSeconds = _intValue(probe['idle_seconds']);
      final isIdle =
          idleSeconds >= _config.idleThresholdSeconds &&
          probe['audio_playing'] != true &&
          probe['foreground_fullscreen'] != true;
      if (isIdle) {
        _wasIdle = true;
        final heartbeatDue =
            now.difference(_lastReportAt) >=
            Duration(seconds: _config.heartbeatSeconds);
        if (heartbeatDue) {
          await _sendReport(
            reporter,
            appId: 'idle',
            windowTitle: 'User is away',
            probe: probe,
            now: now,
          );
        } else {
          _setSnapshot(
            _snapshot.copyWith(
              status: 'AFK',
              currentTarget: _previousTarget?['display'] ?? 'idle',
            ),
          );
        }
        return;
      }

      if (_wasIdle) {
        _wasIdle = false;
        _setSnapshot(_snapshot.copyWith(status: '在线'));
      }
      final appId = _text(probe['app_id']);
      final title = _text(probe['window_title']);
      if (appId.isEmpty && title.isEmpty) {
        return;
      }
      final display = title.isEmpty ? appId : '$appId · $title';
      _setSnapshot(
        _snapshot.copyWith(status: '在线', currentTarget: display, lastError: ''),
      );
      final changed =
          _previousTarget == null ||
          _previousTarget?['app_id'] != appId ||
          _previousTarget?['window_title'] != title;
      final heartbeatDue =
          now.difference(_lastReportAt) >=
          Duration(seconds: _config.heartbeatSeconds);
      if (changed || heartbeatDue) {
        await _sendReport(
          reporter,
          appId: appId,
          windowTitle: title,
          probe: probe,
          now: now,
        );
      }
    } catch (error, stack) {
      await _logService.write(_config, 'runtime exception: $error\n$stack');
      _setSnapshot(
        _snapshot.copyWith(
          status: '运行异常',
          lastError: error.toString(),
          isRunning: true,
        ),
      );
    } finally {
      if (generation == _generation && _snapshot.isRunning) {
        _scheduleNext(_nextDelay(), generation);
      }
    }
  }

  void _scheduleNext(Duration delay, int generation) {
    _timer?.cancel();
    _timer = Timer(delay, () {
      if (generation == _generation) {
        unawaited(_tick());
      }
    });
  }

  Duration _nextDelay() {
    final retryDelay = _reportClient?.retryDelay ?? Duration.zero;
    if (retryDelay > Duration.zero) {
      return retryDelay;
    }
    return Duration(seconds: _config.intervalSeconds);
  }

  Future<void> _sendReport(
    ReportClient reporter, {
    required String appId,
    required String windowTitle,
    required Map<Object?, Object?> probe,
    required DateTime now,
  }) async {
    final extra = <String, Object?>{};
    if (probe['battery_percent'] is num) {
      extra['battery_percent'] = (probe['battery_percent'] as num).toInt();
      extra['battery_charging'] = probe['battery_charging'] == true;
    }
    if (probe['music'] is Map) {
      extra['music'] = Map<String, Object?>.from(probe['music']! as Map);
    }
    final result = await reporter.send(
      appId: appId,
      windowTitle: windowTitle,
      extra: desktopDeviceProfile(extra),
    );
    if (result.ok) {
      _lastReportAt = now;
      _previousTarget = {
        'app_id': appId,
        'window_title': windowTitle,
        'display': windowTitle.isEmpty ? appId : '$appId · $windowTitle',
      };
      _setSnapshot(
        RuntimeSnapshot(
          status: appId == 'idle' ? 'AFK' : '在线',
          currentTarget: _previousTarget!['display']!,
          lastReportAt: now,
          lastError: '',
          isRunning: true,
        ),
      );
    } else {
      await _logService.write(_config, 'report failed: ${result.error}');
      _setSnapshot(
        _snapshot.copyWith(
          status: '上报失败',
          lastError: result.error,
          isRunning: true,
        ),
      );
    }
  }

  Future<void> _fetchPendingMessages(DeviceMessageClient client) async {
    final incoming = <DeviceMessage>[];
    for (final message in await client.fetchPending()) {
      final envelope = DeviceCommandEnvelope.fromMessage(message);
      if (envelope == null) {
        incoming.add(message);
        continue;
      }
      final receiptOk = await client.sendCommandAck(
        _commandExecutor.receiptFrame(envelope),
      );
      final execution = _commandExecutor.execute(envelope);
      final resultOk = await client.sendCommandAck(execution.resultFrame);
      final display = execution.displayMessage;
      if (display != null) {
        incoming.add(display);
      }
      if (!receiptOk || !resultOk) {
        _setSnapshot(
          _snapshot.copyWith(
            status: '命令回执失败',
            lastError: 'receipt=$receiptOk, result=$resultOk',
          ),
        );
      }
    }
    if (incoming.isNotEmpty) {
      _messageHistory.addIncoming(incoming);
    }
  }

  void _setSnapshot(RuntimeSnapshot snapshot) {
    _snapshot = snapshot;
    _snapshotController.add(snapshot);
  }

  void dispose() {
    stop();
    _snapshotController.close();
  }

  static int _intValue(Object? value) => value is num ? value.toInt() : 0;
  static String _text(Object? value) => value is String ? value.trim() : '';
}
