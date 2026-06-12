import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../models/app_config.dart';
import '../models/device_message.dart';

class DeviceMessageClient {
  DeviceMessageClient(AppConfig config)
    : _config = config.normalize(),
      _client = HttpClient() {
    _client.connectionTimeout = const Duration(seconds: 15);
  }

  static const _timeout = Duration(seconds: 15);
  final AppConfig _config;
  final HttpClient _client;

  Future<List<DeviceMessage>> fetchHistory({String since = ''}) {
    final suffix = since.isEmpty
        ? '/api/messages/history'
        : '/api/messages/history?since=${Uri.encodeQueryComponent(since)}';
    return _getMessages(suffix);
  }

  Future<List<DeviceMessage>> fetchPending() {
    return _getMessages('/api/messages');
  }

  Future<bool> sendCommandAck(Map<String, Object?> frame) async {
    try {
      final request = await _client
          .postUrl(_endpoint('/api/supervision/ack'))
          .timeout(_timeout);
      request.headers.contentType = ContentType.json;
      request.headers.set(
        HttpHeaders.authorizationHeader,
        'Bearer ${_config.token}',
      );
      request.write(jsonEncode(frame));
      final response = await request.close().timeout(_timeout);
      await response.drain<void>().timeout(_timeout);
      return response.statusCode >= 200 && response.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  Future<List<DeviceMessage>> _getMessages(String suffix) async {
    final request = await _client.getUrl(_endpoint(suffix)).timeout(_timeout);
    request.headers.set(
      HttpHeaders.authorizationHeader,
      'Bearer ${_config.token}',
    );
    final response = await request.close().timeout(_timeout);
    final body = await utf8.decodeStream(response).timeout(_timeout);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw DeviceMessageClientException(
        '消息请求失败: HTTP ${response.statusCode} ${response.reasonPhrase}'.trim(),
        response.statusCode,
        body,
      );
    }
    return DeviceMessage.listFromJson(body);
  }

  Uri _endpoint(String suffix) {
    return Uri.parse(
      '${_config.serverUrl.replaceFirst(RegExp(r'/+$'), '')}$suffix',
    );
  }

  void close() {
    _client.close(force: true);
  }
}

class DeviceMessageClientException implements Exception {
  const DeviceMessageClientException(
    this.message,
    this.statusCode,
    this.responseBody,
  );

  final String message;
  final int statusCode;
  final String responseBody;

  @override
  String toString() => message;
}
