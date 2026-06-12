import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../theme/app_design.dart';

class AppPanel extends StatelessWidget {
  const AppPanel({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppDesign.panelPadding),
  });

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
          decoration: BoxDecoration(
            color: AppDesign.surfaceMuted,
            borderRadius: BorderRadius.circular(AppDesign.radius + 3),
            border: Border.all(color: AppDesign.border),
          ),
          child: Padding(
            padding: const EdgeInsets.all(AppDesign.panelChromePadding),
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: AppDesign.surface,
                borderRadius: BorderRadius.circular(AppDesign.radius),
                border: Border.all(color: const Color(0xfff0eee8)),
              ),
              child: Padding(padding: padding, child: child),
            ),
          ),
        )
        .animate()
        .fadeIn(duration: AppDesign.fast, curve: AppDesign.curve)
        .slideY(
          begin: 0.012,
          end: 0,
          duration: AppDesign.medium,
          curve: AppDesign.curve,
        );
  }
}
