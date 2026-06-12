import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../models/app_config.dart';

class ReportClient {
  ReportClient(AppConfig config)
    : _config = config.normalize(),
      _client = HttpClient() {
    _client.connectionTimeout = const Duration(seconds: 10);
  }

  static const _requestTimeout = Duration(seconds: 10);
  static const _maxBackoff = Duration(seconds: 60);
  static const _pauseAfterFailures = 5;
  static const _pauseDuration = Duration(minutes: 5);

  final AppConfig _config;
  final HttpClient _client;
  int _consecutiveFailures = 0;
  Duration _currentBackoff = Duration.zero;
  DateTime _pauseUntil = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);

  Duration get retryDelay {
    final remaining = _pauseUntil.difference(DateTime.now().toUtc());
    if (remaining.isNegative || remaining == Duration.zero) {
      return _currentBackoff;
    }
    return remaining;
  }

  Future<ReportResult> send({
    required String appId,
    required String windowTitle,
    required Map<String, Object?> extra,
  }) async {
    if (retryDelay > _currentBackoff) {
      return const ReportResult(false, '上报暂停中。');
    }
    try {
      final endpoint = Uri.parse(
        '${_config.serverUrl.replaceFirst(RegExp(r'/+$'), '')}/api/report',
      );
      final request = await _client.postUrl(endpoint).timeout(_requestTimeout);
      request.headers.contentType = ContentType.json;
      request.headers.set(
        HttpHeaders.authorizationHeader,
        'Bearer ${_config.token}',
      );
      request.write(
        jsonEncode({
          'app_id': appId,
          'window_title': windowTitle.length > 256
              ? windowTitle.substring(0, 256)
              : windowTitle,
          'timestamp': DateTime.now().toUtc().toIso8601String(),
          'extra': extra,
        }),
      );
      final response = await request.close().timeout(_requestTimeout);
      final body = await utf8.decodeStream(response).timeout(_requestTimeout);
      if (response.statusCode == 200 ||
          response.statusCode == 201 ||
          response.statusCode == 409) {
        _consecutiveFailures = 0;
        _currentBackoff = Duration.zero;
        _pauseUntil = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
        return const ReportResult(true, '');
      }
      _registerFailure();
      return ReportResult(
        false,
        'HTTP ${response.statusCode}: ${body.substring(0, body.length > 200 ? 200 : body.length)}',
      );
    } catch (error) {
      _registerFailure();
      return ReportResult(false, error.toString());
    }
  }

  void close() {
    _client.close(force: true);
  }

  void _registerFailure() {
    _consecutiveFailures += 1;
    _currentBackoff = _currentBackoff == Duration.zero
        ? const Duration(seconds: 5)
        : Duration(
            seconds: (_currentBackoff.inSeconds * 2).clamp(
              5,
              _maxBackoff.inSeconds,
            ),
          );
    if (_consecutiveFailures >= _pauseAfterFailures) {
      _pauseUntil = DateTime.now().toUtc().add(_pauseDuration);
      _consecutiveFailures = 0;
      _currentBackoff = Duration.zero;
    }
  }
}

class ReportResult {
  const ReportResult(this.ok, this.error);

  final bool ok;
  final String error;
}
