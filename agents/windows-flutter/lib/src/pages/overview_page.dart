import 'package:flutter/material.dart';

import '../controllers/app_controller.dart';
import '../theme/app_design.dart';
import '../widgets/app_panel.dart';
import '../widgets/page_header.dart';

class OverviewPage extends StatelessWidget {
  const OverviewPage({super.key, required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final currentRuntime = controller.runtime;
        return LayoutBuilder(
          builder: (context, constraints) {
            final compact = constraints.maxWidth < 980;
            final pagePadding = compact
                ? AppDesign.compactPagePadding
                : AppDesign.pagePadding;
            final gap = compact ? 10.0 : 14.0;
            return Padding(
              padding: EdgeInsets.all(pagePadding),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const PageHeader(
                    title: 'Live Dashboard Agent',
                    subtitle: 'Windows 桌面采集与消息接收',
                  ),
                  SizedBox(height: compact ? 14 : 18),
                  _MetricGrid(
                    gap: gap,
                    children: [
                      _MetricPanel(
                        title: '状态',
                        value: currentRuntime.status,
                        icon: currentRuntime.isRunning
                            ? Icons.check_circle
                            : Icons.pause_circle,
                      ),
                      _MetricPanel(
                        title: '最近窗口',
                        value: currentRuntime.currentTarget,
                        icon: Icons.web_asset,
                      ),
                      _MetricPanel(
                        title: '上次上报',
                        value:
                            currentRuntime.lastReportAt
                                ?.toLocal()
                                .toString()
                                .split('.')
                                .first ??
                            '尚未上报',
                        icon: Icons.schedule,
                      ),
                    ],
                  ),
                  SizedBox(height: compact ? 12 : 14),
                  Expanded(
                    child: SingleChildScrollView(
                      child: AppPanel(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                const Icon(Icons.info_outline, size: 18),
                                const SizedBox(width: 7),
                                Text(
                                  '运行细节',
                                  style: Theme.of(
                                    context,
                                  ).textTheme.titleMedium,
                                ),
                                const Spacer(),
                                IconButton(
                                  tooltip: '刷新消息',
                                  onPressed: controller.refreshMessages,
                                  icon: const Icon(Icons.refresh),
                                  iconSize: 20,
                                ),
                                IconButton(
                                  tooltip: '打开日志文件夹',
                                  onPressed: controller.openLogs,
                                  icon: const Icon(Icons.folder_open),
                                  iconSize: 20,
                                ),
                              ],
                            ),
                            const SizedBox(height: 10),
                            _InfoRow(
                              label: '程序目录',
                              value: controller.baseDirectory,
                            ),
                            _InfoRow(
                              label: '可执行文件',
                              value: controller.executablePath,
                            ),
                            _InfoRow(
                              label: '错误',
                              value: currentRuntime.lastError.isEmpty
                                  ? '无'
                                  : currentRuntime.lastError,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }
}

class _MetricGrid extends StatelessWidget {
  const _MetricGrid({required this.children, required this.gap});

  final List<Widget> children;
  final double gap;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 900
            ? 3
            : constraints.maxWidth >= 560
            ? 2
            : 1;
        final width = (constraints.maxWidth - gap * (columns - 1)) / columns;
        return Wrap(
          spacing: gap,
          runSpacing: gap,
          children: [
            for (final child in children) SizedBox(width: width, child: child),
          ],
        );
      },
    );
  }
}

class _MetricPanel extends StatelessWidget {
  const _MetricPanel({
    required this.title,
    required this.value,
    required this.icon,
  });

  final String title;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return AppPanel(
      padding: const EdgeInsets.all(14),
      child: Row(
        children: [
          DecoratedBox(
            decoration: BoxDecoration(
              color: AppDesign.accentSoft,
              borderRadius: BorderRadius.circular(AppDesign.radius),
            ),
            child: Padding(
              padding: const EdgeInsets.all(7),
              child: Icon(icon, color: AppDesign.accent, size: 18),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: Theme.of(
                    context,
                  ).textTheme.labelMedium?.copyWith(color: AppDesign.muted),
                ),
                const SizedBox(height: 3),
                Text(
                  value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 82,
            child: Text(
              label,
              style: Theme.of(
                context,
              ).textTheme.labelLarge?.copyWith(color: AppDesign.muted),
            ),
          ),
          Expanded(
            child: SelectableText(
              value.isEmpty ? '未设置' : value,
              style: value.isEmpty
                  ? const TextStyle(color: AppDesign.muted)
                  : null,
            ),
          ),
        ],
      ),
    );
  }
}
