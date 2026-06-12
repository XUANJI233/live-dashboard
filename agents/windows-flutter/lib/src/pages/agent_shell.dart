import 'package:flutter/material.dart';

import '../controllers/app_controller.dart';
import '../theme/app_design.dart';
import 'messages_page.dart';
import 'overview_page.dart';
import 'settings_page.dart';

class AgentShell extends StatefulWidget {
  const AgentShell({super.key, required this.controller});

  final AppController controller;

  @override
  State<AgentShell> createState() => _AgentShellState();
}

class _AgentShellState extends State<AgentShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      OverviewPage(controller: widget.controller),
      MessagesPage(controller: widget.controller),
      SettingsPage(controller: widget.controller),
    ];
    return Scaffold(
      body: Row(
        children: [
          _SideNav(
            selectedIndex: _index,
            onSelected: (value) => setState(() => _index = value),
          ),
          Expanded(
            child: AnimatedSwitcher(
              duration: AppDesign.medium,
              switchInCurve: AppDesign.curve,
              switchOutCurve: AppDesign.curve,
              transitionBuilder: (child, animation) {
                return FadeTransition(
                  opacity: animation,
                  child: SlideTransition(
                    position: Tween<Offset>(
                      begin: const Offset(0.012, 0),
                      end: Offset.zero,
                    ).animate(animation),
                    child: child,
                  ),
                );
              },
              child: KeyedSubtree(key: ValueKey(_index), child: pages[_index]),
            ),
          ),
        ],
      ),
    );
  }
}

class _SideNav extends StatelessWidget {
  const _SideNav({required this.selectedIndex, required this.onSelected});

  final int selectedIndex;
  final ValueChanged<int> onSelected;

  @override
  Widget build(BuildContext context) {
    const items = [
      (Icons.grid_view_rounded, '概览'),
      (Icons.chat_bubble_outline_rounded, '消息'),
      (Icons.tune_rounded, '设置'),
    ];
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: AppDesign.surface,
        border: Border(right: BorderSide(color: AppDesign.border)),
      ),
      child: SizedBox(
        width: AppDesign.sidebarWidth,
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 16),
            child: Column(
              children: [
                for (var i = 0; i < items.length; i++) ...[
                  _NavItem(
                    icon: items[i].$1,
                    label: items[i].$2,
                    selected: selectedIndex == i,
                    onTap: () => onSelected(i),
                  ),
                  if (i != items.length - 1) const SizedBox(height: 8),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = selected ? AppDesign.accent : AppDesign.ink;
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(AppDesign.radius),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppDesign.radius),
        onTap: onTap,
        child: SizedBox(
          width: 56,
          height: 68,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              SizedBox.square(
                dimension: 36,
                child: AnimatedContainer(
                  duration: AppDesign.fast,
                  curve: AppDesign.curve,
                  decoration: BoxDecoration(
                    color: selected ? AppDesign.accentSoft : Colors.transparent,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                      color: selected
                          ? const Color(0x331f6c9f)
                          : Colors.transparent,
                    ),
                  ),
                  child: Icon(icon, size: 19, color: color),
                ),
              ),
              const SizedBox(height: 5),
              Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: color,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
