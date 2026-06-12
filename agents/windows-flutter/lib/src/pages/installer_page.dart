import 'package:flutter/material.dart';

import '../controllers/app_controller.dart';
import '../models/distribution.dart';
import '../theme/app_design.dart';
import '../widgets/app_panel.dart';
import '../widgets/page_header.dart';

class InstallerPage extends StatefulWidget {
  const InstallerPage({super.key, required this.controller});

  final AppController controller;

  @override
  State<InstallerPage> createState() => _InstallerPageState();
}

class _InstallerPageState extends State<InstallerPage> {
  late final TextEditingController _installDirectory;
  late String _lastInstallDirectoryFromState;
  bool _createShortcut = true;
  bool _launchAfterInstall = true;

  @override
  void initState() {
    super.initState();
    _lastInstallDirectoryFromState =
        widget.controller.installState.installDirectory;
    _installDirectory = TextEditingController(
      text: _lastInstallDirectoryFromState,
    );
  }

  @override
  void dispose() {
    _installDirectory.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final state = widget.controller.installState;
        _syncDirectoryText(state.installDirectory);
        return Scaffold(
          body: SafeArea(
            child: LayoutBuilder(
              builder: (context, constraints) {
                final compact = constraints.maxWidth < 720;
                return SingleChildScrollView(
                  padding: EdgeInsets.all(
                    compact
                        ? AppDesign.compactPagePadding
                        : AppDesign.pagePadding,
                  ),
                  child: Align(
                    alignment: Alignment.topLeft,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 680),
                      child: AppPanel(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const PageHeader(
                              title: '安装 Agent',
                              subtitle: '选择安装范围和目录',
                            ),
                            const SizedBox(height: 16),
                            SegmentedButton<InstallScope>(
                              segments: InstallScope.values
                                  .map(
                                    (scope) => ButtonSegment(
                                      value: scope,
                                      label: Text(scope.label),
                                    ),
                                  )
                                  .toList(growable: false),
                              selected: {state.scope},
                              onSelectionChanged: state.isBusy
                                  ? null
                                  : (value) => widget.controller
                                        .setInstallScope(value.first),
                            ),
                            const SizedBox(height: 12),
                            TextField(
                              controller: _installDirectory,
                              style: Theme.of(context).textTheme.bodyMedium,
                              onChanged: (value) {
                                _lastInstallDirectoryFromState = value;
                                widget.controller.setInstallDirectory(value);
                              },
                              decoration: InputDecoration(
                                isDense: true,
                                labelText: '安装目录',
                                prefixIcon: const Icon(Icons.folder_outlined),
                                suffixIcon: IconButton(
                                  tooltip: '选择目录',
                                  onPressed: state.isBusy
                                      ? null
                                      : widget.controller.chooseInstallFolder,
                                  icon: const Icon(Icons.more_horiz),
                                ),
                              ),
                            ),
                            const SizedBox(height: 8),
                            CheckboxListTile(
                              dense: true,
                              visualDensity: VisualDensity.compact,
                              contentPadding: EdgeInsets.zero,
                              value: _createShortcut,
                              onChanged: state.isBusy
                                  ? null
                                  : (value) => setState(
                                      () => _createShortcut = value ?? true,
                                    ),
                              title: const Text('创建桌面快捷方式'),
                              controlAffinity: ListTileControlAffinity.leading,
                            ),
                            CheckboxListTile(
                              dense: true,
                              visualDensity: VisualDensity.compact,
                              contentPadding: EdgeInsets.zero,
                              value: _launchAfterInstall,
                              onChanged: state.isBusy
                                  ? null
                                  : (value) => setState(
                                      () => _launchAfterInstall = value ?? true,
                                    ),
                              title: const Text('安装完成后启动主界面'),
                              controlAffinity: ListTileControlAffinity.leading,
                            ),
                            const SizedBox(height: 10),
                            FilledButton.icon(
                              onPressed: state.isBusy
                                  ? null
                                  : () => widget.controller.install(
                                      createDesktopShortcut: _createShortcut,
                                      launchAfterInstall: _launchAfterInstall,
                                    ),
                              icon: state.isBusy
                                  ? const SizedBox.square(
                                      dimension: 16,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : const Icon(Icons.download_done),
                              label: const Text('安装'),
                            ),
                            if (state.lastMessage.isNotEmpty) ...[
                              const SizedBox(height: 12),
                              Text(state.lastMessage),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        );
      },
    );
  }

  void _syncDirectoryText(String value) {
    if (value == _lastInstallDirectoryFromState) {
      return;
    }
    _lastInstallDirectoryFromState = value;
    _installDirectory.text = value;
    _installDirectory.selection = TextSelection.collapsed(offset: value.length);
  }
}
