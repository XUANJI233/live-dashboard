class RuntimeSnapshot {
  const RuntimeSnapshot({
    required this.status,
    required this.currentTarget,
    required this.lastReportAt,
    required this.lastError,
    required this.isRunning,
  });

  const RuntimeSnapshot.stopped()
    : status = '已停止',
      currentTarget = '暂无窗口',
      lastReportAt = null,
      lastError = '',
      isRunning = false;

  final String status;
  final String currentTarget;
  final DateTime? lastReportAt;
  final String lastError;
  final bool isRunning;

  RuntimeSnapshot copyWith({
    String? status,
    String? currentTarget,
    DateTime? lastReportAt,
    String? lastError,
    bool? isRunning,
  }) {
    return RuntimeSnapshot(
      status: status ?? this.status,
      currentTarget: currentTarget ?? this.currentTarget,
      lastReportAt: lastReportAt ?? this.lastReportAt,
      lastError: lastError ?? this.lastError,
      isRunning: isRunning ?? this.isRunning,
    );
  }
}
