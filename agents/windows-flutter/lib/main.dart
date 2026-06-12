import 'package:flutter/material.dart';

import 'src/app.dart';

void main(List<String> arguments) {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(LiveDashboardAgentApp(arguments: arguments));
}
