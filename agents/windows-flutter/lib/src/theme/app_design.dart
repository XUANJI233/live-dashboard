import 'package:flutter/material.dart';

class AppDesign {
  static const primaryFont = 'Microsoft YaHei UI';
  static const fontFallback = [
    'Segoe UI Variable',
    'Segoe UI',
    'Microsoft YaHei',
  ];

  static const canvas = Color(0xfff7f6f3);
  static const surface = Color(0xffffffff);
  static const surfaceMuted = Color(0xfffbfbfa);
  static const ink = Color(0xff202124);
  static const muted = Color(0xff707070);
  static const border = Color(0xffe7e4dd);
  static const accent = Color(0xff1f6c9f);
  static const accentSoft = Color(0xffe1f3fe);
  static const success = Color(0xff346538);
  static const successSoft = Color(0xffedf3ec);
  static const warning = Color(0xff956400);
  static const warningSoft = Color(0xfffbf3db);
  static const danger = Color(0xff9f2f2d);
  static const dangerSoft = Color(0xfffdebec);

  static const radius = 8.0;
  static const pagePadding = 18.0;
  static const compactPagePadding = 10.0;
  static const panelPadding = 12.0;
  static const panelChromePadding = 1.0;
  static const sidebarWidth = 76.0;

  static const curve = Cubic(0.16, 1, 0.3, 1);
  static const fast = Duration(milliseconds: 180);
  static const medium = Duration(milliseconds: 260);

  static TextStyle mono(BuildContext context) {
    return Theme.of(context).textTheme.bodySmall!.copyWith(
      fontFamily: primaryFont,
      fontFamilyFallback: fontFallback,
      fontFeatures: const [FontFeature.tabularFigures()],
      letterSpacing: 0,
      color: muted,
    );
  }
}
