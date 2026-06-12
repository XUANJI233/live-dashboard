import 'package:flutter/material.dart';

import '../controllers/app_controller.dart';
import '../models/app_config.dart';
import '../theme/app_design.dart';
import '../widgets/app_panel.dart';
import '../widgets/page_header.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.controller});

  final AppController controller;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late final TextEditingController _server;
  late final TextEditingController _token;
  late double _interval;
  late double _heartbeat;
  late double _idle;
  late bool _enableLog;
  bool _removeLogsOnUninstall = false;
  String _message = '';

  @override
  void initState() {
    super.initState();
    final config = widget.controller.config;
    _server = TextEditingController(text: config.serverUrl);
    _token = TextEditingController(text: config.token);
    _interval = config.intervalSeconds.toDouble();
    _heartbeat = config.heartbeatSeconds.toDouble();
    _idle = config.idleThresholdSeconds.toDouble();
    _enableLog = config.enableLog;
  }

  @override
  void dispose() {
    _server.dispose();
    _token.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        return Padding(
          padding: const EdgeInsets.all(AppDesign.pagePadding),
          child: ListView(
            children: [
              const PageHeader(title: '设置', subtitle: '服务器、启动和日志'),
              const SizedBox(height: 20),
              AppPanel(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    TextField(
                      controller: _server,
                      decoration: const InputDecoration(
                        labelText: '服务器地址',
                        prefixIcon: Icon(Icons.cloud_outlined),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _token,
                      obscureText: true,
                      decoration: const InputDecoration(
                        labelText: '设备 Token',
                        prefixIcon: Icon(Icons.key_outlined),
                      ),
                    ),
                    const SizedBox(height: 18),
                    _SliderRow(
                      label: '采样间隔',
                      value: _interval,
                      min: 1,
                      max: 60,
                      divisions: 59,
                      suffix: '秒',
                      onChanged: (value) => setState(() => _interval = value),
                    ),
                    _SliderRow(
                      label: '心跳间隔',
                      value: _heartbeat,
                      min: 10,
                      max: 300,
                      divisions: 29,
                      suffix: '秒',
                      onChanged: (value) => setState(() => _heartbeat = value),
                    ),
                    _SliderRow(
                      label: '离开判定',
                      value: _idle,
                      min: 30,
                      max: 1800,
                      divisions: 59,
                      suffix: '秒',
                      onChanged: (value) => setState(() => _idle = value),
                    ),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      value: _enableLog,
                      onChanged: (value) => setState(() => _enableLog = value),
                      title: const Text('输出日志'),
                      secondary: const Icon(Icons.description_outlined),
                    ),
                    Row(
                      children: [
                        FilledButton.icon(
                          onPressed: _save,
                          icon: const Icon(Icons.save),
                          label: const Text('保存'),
                        ),
                        const SizedBox(width: 10),
                        OutlinedButton.icon(
                          onPressed: widget.controller.openLogs,
                          icon: const Icon(Icons.folder_open),
                          label: const Text('日志文件夹'),
                        ),
                        const SizedBox(width: 10),
                        OutlinedButton.icon(
                          onPressed: widget.controller.openLogFile,
                          icon: const Icon(Icons.article_outlined),
                          label: const Text('日志文件'),
                        ),
                      ],
                    ),
                    if (_message.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      Text(
                        _message,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.primary,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 16),
              AppPanel(
                child: SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: widget.controller.startupEnabled,
                  onChanged: widget.controller.toggleStartup,
                  title: const Text('开机自启'),
                  subtitle: const Text('使用注册表 Run 项，并清理同名旧入口'),
                  secondary: const Icon(Icons.rocket_launch_outlined),
                ),
              ),
              if (widget
                  .controller
                  .installState
                  .isRunningFromRegisteredInstall) ...[
                const SizedBox(height: 16),
                AppPanel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '安装管理',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 8),
                      SelectableText(
                        widget.controller.baseDirectory,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      CheckboxListTile(
                        contentPadding: EdgeInsets.zero,
                        value: _removeLogsOnUninstall,
                        onChanged: widget.controller.installState.isBusy
                            ? null
                            : (value) => setState(
                                () => _removeLogsOnUninstall = value ?? false,
                              ),
                        title: const Text('卸载时删除日志'),
                        controlAffinity: ListTileControlAffinity.leading,
                      ),
                      OutlinedButton.icon(
                        onPressed: widget.controller.installState.isBusy
                            ? null
                            : () => widget.controller.uninstallCurrentInstall(
                                removeLogs: _removeLogsOnUninstall,
                              ),
                        icon: const Icon(Icons.delete_outline),
                        label: const Text('卸载当前安装'),
                      ),
                      if (widget
                          .controller
                          .installState
                          .lastMessage
                          .isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(widget.controller.installState.lastMessage),
                      ],
                    ],
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }

  Future<void> _save() async {
    final config = AppConfig(
      serverUrl: _server.text,
      token: _token.text,
      intervalSeconds: _interval.round(),
      heartbeatSeconds: _heartbeat.round(),
      idleThresholdSeconds: _idle.round(),
      enableLog: _enableLog,
    ).normalize();
    final validation = config.validate();
    if (validation != null) {
      setState(() => _message = validation);
      return;
    }
    await widget.controller.saveConfig(config);
    setState(() => _message = '已保存');
  }
}

class _SliderRow extends StatelessWidget {
  const _SliderRow({
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.divisions,
    required this.suffix,
    required this.onChanged,
  });

  final String label;
  final double value;
  final double min;
  final double max;
  final int divisions;
  final String suffix;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        SizedBox(width: 86, child: Text(label)),
        Expanded(
          child: Slider(
            value: value.clamp(min, max),
            min: min,
            max: max,
            divisions: divisions,
            onChanged: onChanged,
          ),
        ),
        SizedBox(
          width: 68,
          child: Text('${value.round()}$suffix', textAlign: TextAlign.end),
        ),
      ],
    );
  }
}
