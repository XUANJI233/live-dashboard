import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as fluent;

import 'controllers/app_controller.dart';
import 'models/distribution.dart';
import 'pages/agent_shell.dart';
import 'pages/installer_page.dart';
import 'services/app_services.dart';
import 'theme/app_design.dart';

class LiveDashboardAgentApp extends StatefulWidget {
  const LiveDashboardAgentApp({super.key, required this.arguments});

  final List<String> arguments;

  @override
  State<LiveDashboardAgentApp> createState() => _LiveDashboardAgentAppState();
}

class _LiveDashboardAgentAppState extends State<LiveDashboardAgentApp> {
  late final AppServices _services;
  late final AppController _controller;

  @override
  void initState() {
    super.initState();
    _services = AppServices.create();
    _controller = AppController(_services);
    _controller.initialize();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: AppDesign.accent,
        brightness: Brightness.light,
      ),
      fontFamily: AppDesign.primaryFont,
      fontFamilyFallback: AppDesign.fontFallback,
      textTheme: const TextTheme(
        headlineSmall: TextStyle(
          fontFamily: AppDesign.primaryFont,
          fontFamilyFallback: AppDesign.fontFallback,
          fontSize: 24,
          fontWeight: FontWeight.w500,
          height: 1.16,
          color: AppDesign.ink,
        ),
        titleMedium: TextStyle(
          fontFamily: AppDesign.primaryFont,
          fontFamilyFallback: AppDesign.fontFallback,
          fontSize: 16,
          fontWeight: FontWeight.w600,
          color: AppDesign.ink,
        ),
        titleSmall: TextStyle(
          fontFamily: AppDesign.primaryFont,
          fontFamilyFallback: AppDesign.fontFallback,
          fontSize: 14,
          fontWeight: FontWeight.w600,
          color: AppDesign.ink,
        ),
        bodyMedium: TextStyle(
          fontFamily: AppDesign.primaryFont,
          fontFamilyFallback: AppDesign.fontFallback,
          fontSize: 13,
          fontWeight: FontWeight.w400,
          height: 1.45,
          color: AppDesign.ink,
        ),
        bodySmall: TextStyle(
          fontFamily: AppDesign.primaryFont,
          fontFamilyFallback: AppDesign.fontFallback,
          fontSize: 12,
          fontWeight: FontWeight.w400,
          height: 1.35,
          color: AppDesign.muted,
        ),
        labelLarge: TextStyle(
          fontFamily: AppDesign.primaryFont,
          fontFamilyFallback: AppDesign.fontFallback,
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: AppDesign.ink,
        ),
        labelMedium: TextStyle(
          fontFamily: AppDesign.primaryFont,
          fontFamilyFallback: AppDesign.fontFallback,
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: AppDesign.muted,
        ),
      ),
      scaffoldBackgroundColor: AppDesign.canvas,
      appBarTheme: const AppBarTheme(
        centerTitle: false,
        elevation: 0,
        backgroundColor: Colors.transparent,
        foregroundColor: AppDesign.ink,
      ),
      cardTheme: const CardThemeData(
        elevation: 0,
        color: AppDesign.surface,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(AppDesign.radius)),
          side: BorderSide(color: AppDesign.border),
        ),
      ),
      inputDecorationTheme: const InputDecorationTheme(
        border: OutlineInputBorder(
          borderRadius: BorderRadius.all(Radius.circular(AppDesign.radius)),
        ),
        filled: true,
        fillColor: AppDesign.surface,
      ),
      segmentedButtonTheme: SegmentedButtonThemeData(
        style: ButtonStyle(
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          ),
        ),
      ),
    );

    return MaterialApp(
      title: 'Live Dashboard Agent',
      debugShowCheckedModeBanner: false,
      theme: theme,
      builder: (context, child) {
        return fluent.FluentTheme(
          data: fluent.FluentThemeData(
            accentColor: fluent.Colors.blue,
            brightness: Brightness.light,
            fontFamily: AppDesign.primaryFont,
            typography: fluent.Typography.raw(
              display: const TextStyle(
                fontFamily: AppDesign.primaryFont,
                fontFamilyFallback: AppDesign.fontFallback,
                fontWeight: FontWeight.w600,
                color: AppDesign.ink,
              ),
              titleLarge: const TextStyle(
                fontFamily: AppDesign.primaryFont,
                fontFamilyFallback: AppDesign.fontFallback,
                fontWeight: FontWeight.w600,
                color: AppDesign.ink,
              ),
              title: const TextStyle(
                fontFamily: AppDesign.primaryFont,
                fontFamilyFallback: AppDesign.fontFallback,
                fontWeight: FontWeight.w600,
                color: AppDesign.ink,
              ),
              subtitle: const TextStyle(
                fontFamily: AppDesign.primaryFont,
                fontFamilyFallback: AppDesign.fontFallback,
                fontWeight: FontWeight.w500,
                color: AppDesign.ink,
              ),
              bodyLarge: const TextStyle(
                fontFamily: AppDesign.primaryFont,
                fontFamilyFallback: AppDesign.fontFallback,
                fontWeight: FontWeight.w400,
                color: AppDesign.ink,
              ),
              body: const TextStyle(
                fontFamily: AppDesign.primaryFont,
                fontFamilyFallback: AppDesign.fontFallback,
                fontWeight: FontWeight.w400,
                color: AppDesign.ink,
              ),
              caption: const TextStyle(
                fontFamily: AppDesign.primaryFont,
                fontFamilyFallback: AppDesign.fontFallback,
                fontWeight: FontWeight.w400,
                color: AppDesign.muted,
              ),
            ),
          ),
          child: child ?? const SizedBox.shrink(),
        );
      },
      home: AnimatedBuilder(
        animation: _controller,
        builder: (context, _) {
          final showInstaller =
              AppDistribution.current == AppDistribution.userInstall &&
              !_controller.installState.isRunningFromRegisteredInstall;
          return showInstaller
              ? InstallerPage(controller: _controller)
              : AgentShell(controller: _controller);
        },
      ),
    );
  }
}
