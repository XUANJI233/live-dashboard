import 'package:flutter/material.dart';

import '../controllers/app_controller.dart';
import '../models/device_message.dart';
import '../theme/app_design.dart';
import '../widgets/app_panel.dart';
import '../widgets/page_header.dart';

class MessagesPage extends StatelessWidget {
  const MessagesPage({super.key, required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final messages = controller.messages;
        return Padding(
          padding: const EdgeInsets.all(AppDesign.pagePadding),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              PageHeader(
                title: '消息',
                subtitle: '${messages.length} 条已缓存消息',
                trailing: IconButton(
                  tooltip: '刷新',
                  onPressed: controller.refreshMessages,
                  icon: const Icon(Icons.refresh),
                ),
              ),
              const SizedBox(height: 20),
              Expanded(
                child: messages.isEmpty
                    ? const AppPanel(child: Center(child: Text('暂无消息')))
                    : ListView.separated(
                        itemCount: messages.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 10),
                        itemBuilder: (context, index) =>
                            _MessageTile(message: messages[index]),
                      ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _MessageTile extends StatelessWidget {
  const _MessageTile({required this.message});

  final DeviceMessage message;

  @override
  Widget build(BuildContext context) {
    final sender = message.viewerRemark.isNotEmpty
        ? message.viewerRemark
        : message.viewerName;
    return AppPanel(
      padding: const EdgeInsets.all(16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            backgroundColor: message.isDeviceCommand
                ? AppDesign.warningSoft
                : AppDesign.accentSoft,
            foregroundColor: message.isDeviceCommand
                ? AppDesign.warning
                : AppDesign.accent,
            radius: 18,
            child: Icon(
              message.isDeviceCommand ? Icons.bolt : Icons.person,
              size: 18,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        sender.isEmpty ? '访客' : sender,
                        style: Theme.of(context).textTheme.titleSmall,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    Text(message.createdAt, style: AppDesign.mono(context)),
                  ],
                ),
                const SizedBox(height: 6),
                SelectableText(message.text.isEmpty ? '(空消息)' : message.text),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
