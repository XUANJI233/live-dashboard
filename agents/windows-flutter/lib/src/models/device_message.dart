import 'dart:convert';

class DeviceMessage {
  const DeviceMessage({
    required this.messageId,
    required this.viewerId,
    required this.viewerName,
    required this.viewerRemark,
    required this.kind,
    required this.direction,
    required this.text,
    required this.createdAt,
    required this.queued,
    required this.payload,
  });

  final String messageId;
  final String viewerId;
  final String viewerName;
  final String viewerRemark;
  final String kind;
  final String direction;
  final String text;
  final String createdAt;
  final bool queued;
  final Map<String, Object?>? payload;

  bool get isDeviceCommand => payload?['type'] == 'device_command';

  static List<DeviceMessage> listFromJson(String body) {
    final decoded = jsonDecode(body);
    final rawItems = switch (decoded) {
      {'messages': final List<dynamic> messages} => messages,
      {'items': final List<dynamic> items} => items,
      List<dynamic> list => list,
      _ => const <dynamic>[],
    };
    return rawItems
        .whereType<Map<String, dynamic>>()
        .map(DeviceMessage.fromMap)
        .where((message) => message.messageId.isNotEmpty)
        .toList(growable: false);
  }

  static DeviceMessage fromMap(Map<String, dynamic> map) {
    return DeviceMessage(
      messageId: _text(map['message_id'] ?? map['id']),
      viewerId: _text(map['viewer_id']),
      viewerName: _text(
        map['viewer_name'] ?? map['sender_name'] ?? map['name'],
      ),
      viewerRemark: _text(map['viewer_remark'] ?? map['remark']),
      kind: _text(map['kind']).isEmpty ? 'message' : _text(map['kind']),
      direction: _text(map['direction']).isEmpty
          ? 'viewer'
          : _text(map['direction']),
      text: _text(map['text'] ?? map['body'] ?? map['message']),
      createdAt: _text(map['created_at'] ?? map['timestamp']),
      queued: map['queued'] == true,
      payload: map['payload'] is Map<String, dynamic>
          ? Map<String, Object?>.from(map['payload'] as Map<String, dynamic>)
          : null,
    );
  }

  static String _text(Object? value) => value is String ? value.trim() : '';
}
