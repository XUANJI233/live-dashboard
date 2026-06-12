import 'dart:collection';

import '../models/device_message.dart';

class MessageHistoryStore {
  final LinkedHashMap<String, DeviceMessage> _messages = LinkedHashMap();

  List<DeviceMessage> get items {
    final values = _messages.values.toList(growable: false);
    values.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return values;
  }

  void replaceAll(Iterable<DeviceMessage> messages) {
    _messages
      ..clear()
      ..addEntries(
        messages.map((message) => MapEntry(message.messageId, message)),
      );
  }

  void addIncoming(Iterable<DeviceMessage> messages) {
    for (final message in messages) {
      if (message.messageId.isNotEmpty) {
        _messages[message.messageId] = message;
      }
    }
    while (_messages.length > 300) {
      _messages.remove(_messages.keys.first);
    }
  }
}
