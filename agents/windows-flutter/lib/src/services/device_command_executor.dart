import '../models/device_message.dart';

class DeviceCommandEnvelope {
  const DeviceCommandEnvelope({
    required this.requestId,
    required this.commandId,
    required this.createdBy,
    required this.issuedAt,
    required this.expiresAt,
    required this.payload,
  });

  final String requestId;
  final String commandId;
  final String createdBy;
  final String issuedAt;
  final String expiresAt;
  final Map<String, Object?> payload;

  bool get isExpired {
    final parsed = DateTime.tryParse(expiresAt);
    return parsed != null && parsed.toUtc().isBefore(DateTime.now().toUtc());
  }

  String text(String name) =>
      payload[name] is String ? (payload[name]! as String).trim() : '';

  bool flag(String name) => payload[name] == true;

  bool hasStringItems(String name) {
    final value = payload[name];
    return value is List &&
        value.any((item) => item is String && item.trim().isNotEmpty);
  }

  String get senderName => switch (createdBy) {
    'mcp' => '设备控制',
    'supervision' || '' => 'AI 监督',
    _ => createdBy,
  };

  static DeviceCommandEnvelope? fromMessage(DeviceMessage message) {
    final payload = message.payload;
    if (payload == null || payload['type'] != 'device_command') {
      return null;
    }
    final commandId = _text(payload['command_id']);
    if (commandId.isEmpty) {
      return null;
    }
    final body = payload['payload'] is Map
        ? Map<String, Object?>.from(payload['payload']! as Map)
        : <String, Object?>{};
    return DeviceCommandEnvelope(
      requestId: _text(payload['request_id']),
      commandId: commandId,
      createdBy: _text(payload['created_by']),
      issuedAt: _text(payload['issued_at']),
      expiresAt: _text(payload['expires_at']),
      payload: body,
    );
  }

  static String _text(Object? value) => value is String ? value.trim() : '';
}

class DeviceCommandExecutor {
  const DeviceCommandExecutor();

  Map<String, Object?> receiptFrame(DeviceCommandEnvelope envelope) {
    return {
      'type': 'device_command_receipt',
      'request_id': envelope.requestId,
      'command_id': envelope.commandId,
      'status': 'received',
      'received_at': _nowIso(),
    };
  }

  DeviceCommandExecution execute(DeviceCommandEnvelope envelope) {
    final kind = envelope.text('kind');
    final say = _trim(envelope.text('say'), 500);
    final actions = <Map<String, Object?>>[];
    final unsupported = <String>[];
    late final String status;
    late final String reason;

    if (envelope.isExpired) {
      status = 'expired';
      reason = 'command_expired';
    } else if (kind == 'supervision_policy') {
      status = 'unsupported';
      reason = 'policy_requires_android_lsp';
    } else if (kind != 'supervision') {
      status = 'unsupported';
      reason = 'unsupported_command_kind:${kind.isEmpty ? 'missing' : kind}';
    } else {
      if (say.isNotEmpty) {
        actions.add({'action': 'say', 'status': 'applied'});
      }
      if (envelope.hasStringItems('freeze_commands')) {
        unsupported.add('freeze');
      }
      if (envelope.hasStringItems('unfreeze_commands')) {
        unsupported.add('unfreeze');
      }
      if (envelope.flag('vibrate')) {
        unsupported.add('vibrate');
      }
      if (envelope.flag('screen_off')) {
        unsupported.add('screen_off');
      }

      if (say.isNotEmpty && unsupported.isNotEmpty) {
        status = 'partial';
        reason = 'unsupported_actions:${unsupported.join(',')}';
      } else if (say.isNotEmpty) {
        status = 'applied';
        reason = '';
      } else if (unsupported.isNotEmpty) {
        status = 'unsupported';
        reason = 'unsupported_actions:${unsupported.join(',')}';
      } else {
        status = 'ignored';
        reason = 'empty_desktop_command';
      }
    }

    final appliedSay = actions.any(
      (action) => action['action'] == 'say' && action['status'] == 'applied',
    );
    final result = {
      'type': 'device_command_result',
      'request_id': envelope.requestId,
      'command_id': envelope.commandId,
      'result_id': envelope.commandId.isEmpty
          ? ''
          : 'res_${envelope.commandId}',
      'status': status,
      'executed_at': _nowIso(),
      'actions': actions,
      'state_after': {'desktop_message_visible': appliedSay},
      'reason': reason,
    };
    final displayMessage = appliedSay
        ? DeviceMessage(
            messageId: envelope.commandId,
            viewerId: '__mcp__',
            viewerName: envelope.senderName,
            viewerRemark: '',
            kind: 'device_command',
            direction: 'viewer',
            text: say,
            createdAt: envelope.issuedAt.isEmpty
                ? _nowIso()
                : envelope.issuedAt,
            queued: false,
            payload: null,
          )
        : null;
    return DeviceCommandExecution(result, displayMessage);
  }

  static String _nowIso() => DateTime.now().toUtc().toIso8601String();
  static String _trim(String value, int maxLength) =>
      value.length <= maxLength ? value : value.substring(0, maxLength);
}

class DeviceCommandExecution {
  const DeviceCommandExecution(this.resultFrame, this.displayMessage);

  final Map<String, Object?> resultFrame;
  final DeviceMessage? displayMessage;
}
