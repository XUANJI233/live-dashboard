#ifndef RUNNER_NATIVE_BRIDGE_H_
#define RUNNER_NATIVE_BRIDGE_H_

#include <flutter/flutter_engine.h>

class FlutterWindow;

void RegisterNativeBridge(flutter::FlutterEngine* engine, FlutterWindow* window);

#endif  // RUNNER_NATIVE_BRIDGE_H_
