import 'distribution.dart';

class InstallState {
  const InstallState({
    required this.installDirectory,
    required this.scope,
    required this.isRunningFromRegisteredInstall,
    required this.isBusy,
    required this.lastMessage,
  });

  const InstallState.initial()
    : installDirectory = '',
      scope = InstallScope.currentUser,
      isRunningFromRegisteredInstall = false,
      isBusy = false,
      lastMessage = '';

  final String installDirectory;
  final InstallScope scope;
  final bool isRunningFromRegisteredInstall;
  final bool isBusy;
  final String lastMessage;

  InstallState copyWith({
    String? installDirectory,
    InstallScope? scope,
    bool? isRunningFromRegisteredInstall,
    bool? isBusy,
    String? lastMessage,
  }) {
    return InstallState(
      installDirectory: installDirectory ?? this.installDirectory,
      scope: scope ?? this.scope,
      isRunningFromRegisteredInstall:
          isRunningFromRegisteredInstall ?? this.isRunningFromRegisteredInstall,
      isBusy: isBusy ?? this.isBusy,
      lastMessage: lastMessage ?? this.lastMessage,
    );
  }
}
