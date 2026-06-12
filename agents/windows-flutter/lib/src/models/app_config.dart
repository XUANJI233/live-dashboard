class AppConfig {
  const AppConfig({
    required this.serverUrl,
    required this.token,
    required this.intervalSeconds,
    required this.heartbeatSeconds,
    required this.idleThresholdSeconds,
    required this.enableLog,
  });

  const AppConfig.empty()
    : serverUrl = '',
      token = '',
      intervalSeconds = 5,
      heartbeatSeconds = 60,
      idleThresholdSeconds = 300,
      enableLog = false;

  final String serverUrl;
  final String token;
  final int intervalSeconds;
  final int heartbeatSeconds;
  final int idleThresholdSeconds;
  final bool enableLog;

  AppConfig normalize() {
    return AppConfig(
      serverUrl: serverUrl.trim(),
      token: token.trim(),
      intervalSeconds: _clamp(intervalSeconds, 1, 300, 5),
      heartbeatSeconds: _clamp(heartbeatSeconds, 10, 600, 60),
      idleThresholdSeconds: _clamp(idleThresholdSeconds, 30, 3600, 300),
      enableLog: enableLog,
    );
  }

  String? validate() {
    final normalized = normalize();
    if (normalized.serverUrl.isEmpty) {
      return '服务器地址不能为空';
    }
    if (normalized.token.isEmpty || normalized.token == 'YOUR_TOKEN_HERE') {
      return 'Token 不能为空';
    }
    final uri = Uri.tryParse(normalized.serverUrl);
    if (uri == null ||
        !uri.hasScheme ||
        !(uri.scheme == 'http' || uri.scheme == 'https')) {
      return '服务器地址必须使用 http:// 或 https://';
    }
    return null;
  }

  AppConfig copyWith({
    String? serverUrl,
    String? token,
    int? intervalSeconds,
    int? heartbeatSeconds,
    int? idleThresholdSeconds,
    bool? enableLog,
  }) {
    return AppConfig(
      serverUrl: serverUrl ?? this.serverUrl,
      token: token ?? this.token,
      intervalSeconds: intervalSeconds ?? this.intervalSeconds,
      heartbeatSeconds: heartbeatSeconds ?? this.heartbeatSeconds,
      idleThresholdSeconds: idleThresholdSeconds ?? this.idleThresholdSeconds,
      enableLog: enableLog ?? this.enableLog,
    );
  }

  Map<String, Object?> toRegistryMap() {
    return {
      'server_url': serverUrl,
      'token': token,
      'interval_seconds': intervalSeconds,
      'heartbeat_seconds': heartbeatSeconds,
      'idle_threshold_seconds': idleThresholdSeconds,
      'enable_log': enableLog,
    };
  }

  static AppConfig fromMap(Map<Object?, Object?> map) {
    return AppConfig(
      serverUrl: (map['server_url'] as String?) ?? '',
      token: (map['token'] as String?) ?? '',
      intervalSeconds: _intValue(map['interval_seconds'], 5),
      heartbeatSeconds: _intValue(map['heartbeat_seconds'], 60),
      idleThresholdSeconds: _intValue(map['idle_threshold_seconds'], 300),
      enableLog: map['enable_log'] == true,
    ).normalize();
  }

  static int _clamp(int value, int min, int max, int fallback) {
    return value < min || value > max ? fallback : value;
  }

  static int _intValue(Object? value, int fallback) {
    if (value is int) {
      return value;
    }
    if (value is num) {
      return value.toInt();
    }
    if (value is String) {
      return int.tryParse(value) ?? fallback;
    }
    return fallback;
  }
}
