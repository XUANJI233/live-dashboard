import 'dart:convert';
import 'dart:io';

import '../models/distribution.dart';
import 'install_directory_safety.dart';
import 'startup_service.dart';
import 'windows_bridge.dart';

class InstallerService {
  InstallerService({
    required WindowsBridge bridge,
    required StartupService startup,
  }) : _bridge = bridge,
       _startup = startup;

  final WindowsBridge _bridge;
  final StartupService _startup;

  Future<String> defaultDirectory(InstallScope scope) async {
    final env = Platform.environment;
    if (scope == InstallScope.allUsers) {
      return r'C:\Program Files\LiveDashboardAgent';
    }
    final localAppData =
        env['LOCALAPPDATA'] ?? '${env['USERPROFILE']}\\AppData\\Local';
    return '$localAppData\\LiveDashboardAgent';
  }

  Future<bool> isRunningFromRegisteredInstall() async {
    return await runningInstallScope() != null;
  }

  Future<InstallScope?> runningInstallScope() async {
    final paths = await _bridge.getPaths();
    final baseDirectory = (paths['base_directory'] as String?) ?? '';
    for (final scope in InstallScope.values) {
      final marker = File(
        '${InstallDirectorySafety.normalize(baseDirectory)}\\${InstallDirectorySafety.markerFileName}',
      );
      if (await marker.exists()) {
        final data = jsonDecode(await marker.readAsString());
        if (data is Map && data['scope'] == scope.registryValue) {
          return scope;
        }
      }
    }
    return null;
  }

  Future<InstallResult> install({
    required String installDirectory,
    required InstallScope scope,
    required bool createDesktopShortcut,
    required bool launchAfterInstall,
  }) async {
    final target = InstallDirectorySafety.normalize(installDirectory);
    final validation = InstallDirectorySafety.validateInstallTarget(target);
    if (validation != null) {
      return InstallResult(false, false, validation, target);
    }
    final paths = await _bridge.getPaths();
    final source = InstallDirectorySafety.normalize(
      (paths['base_directory'] as String?) ?? '',
    );
    final executable = (paths['executable_path'] as String?) ?? '';
    if (source.isEmpty || executable.isEmpty) {
      return InstallResult(false, false, '无法定位当前程序目录。', target);
    }
    if (InstallDirectorySafety.isChildOrSame(source, target)) {
      return InstallResult(false, false, '安装路径不能是当前程序目录、父目录或子目录。', target);
    }

    final admin = await _bridge.isAdministrator();
    if (scope == InstallScope.allUsers && !admin) {
      return InstallResult(false, false, '所有用户安装需要以管理员身份运行安装器。', target);
    }

    final files = await _copyDirectory(source, target);
    final manifest = <String, Object?>{
      'version': 1,
      'scope': scope.registryValue,
      'installed_at': DateTime.now().toUtc().toIso8601String(),
      'files': files,
    };
    final marker = File('$target\\${InstallDirectorySafety.markerFileName}');
    await marker.writeAsString(jsonEncode({'scope': scope.registryValue}));
    final manifestFile = File('$target\\install-manifest.json');
    await manifestFile.writeAsString(
      const JsonEncoder.withIndent('  ').convert(manifest),
    );
    final targetExe = '$target\\${executable.split(RegExp(r'[\\/]')).last}';
    await _startup.setEnabled(
      scope: scope,
      executablePath: targetExe,
      enabled: true,
    );
    if (createDesktopShortcut) {
      await _bridge.createDesktopShortcut(targetExe);
    }
    if (launchAfterInstall) {
      await _bridge.launchProcess(targetExe, const <String>[]);
    }
    return InstallResult(true, true, '${scope.label}安装完成。', target);
  }

  Future<InstallResult> uninstall({
    required String installDirectory,
    required InstallScope scope,
    required bool removeLogs,
  }) async {
    final target = InstallDirectorySafety.normalize(installDirectory);
    final validation = InstallDirectorySafety.validateInstallTarget(target);
    if (validation != null) {
      return InstallResult(false, false, validation, target);
    }
    final directory = Directory(target);
    if (!await directory.exists()) {
      return InstallResult(false, false, '安装目录不存在。', target);
    }
    final manifestFile = File('$target\\install-manifest.json');
    if (!await manifestFile.exists()) {
      return InstallResult(false, false, '缺少安装清单，已拒绝卸载以避免删错目录。', target);
    }
    final manifest = jsonDecode(await manifestFile.readAsString());
    if (manifest is! Map ||
        manifest['scope'] != scope.registryValue ||
        manifest['files'] is! List) {
      return InstallResult(false, false, '安装清单不匹配，已拒绝卸载。', target);
    }
    final exe = (await _bridge.getPaths())['executable_path'] as String? ?? '';
    await _startup.setEnabled(
      scope: scope,
      executablePath: exe,
      enabled: false,
    );
    var deleted = 0;
    for (final item in (manifest['files'] as List).whereType<Map>()) {
      final relative = item['path'] as String? ?? '';
      if (relative.isEmpty || relative.contains('..')) {
        continue;
      }
      final file = File('$target\\$relative');
      if (!await file.exists()) {
        continue;
      }
      final size = await file.length();
      final hash = await _bridge.sha256File(file.path);
      if (size == item['size'] && hash == item['sha256']) {
        await file.delete();
        deleted += 1;
      }
    }
    await _deleteFileIfExists(manifestFile);
    await _deleteFileIfExists(
      File('$target\\${InstallDirectorySafety.markerFileName}'),
    );
    if (removeLogs) {
      await _deleteDirectoryIfExists(
        Directory('$target\\logs'),
        recursive: true,
      );
    }
    await _deleteEmptyDirectories(directory);
    return InstallResult(
      true,
      deleted > 0,
      '卸载完成，已删除 $deleted 个受清单保护的文件。',
      target,
    );
  }

  Future<List<Map<String, Object?>>> _copyDirectory(
    String source,
    String target,
  ) async {
    final output = <Map<String, Object?>>[];
    final sourceDir = Directory(source);
    await Directory(target).create(recursive: true);
    await for (final entity in sourceDir.list(
      recursive: true,
      followLinks: false,
    )) {
      if (entity is! File) {
        continue;
      }
      final relative = entity.path
          .substring(source.length)
          .replaceFirst(RegExp(r'^[\\/]'), '');
      if (relative.startsWith('logs\\') ||
          relative == 'install-manifest.json') {
        continue;
      }
      final destination = File('$target\\$relative');
      await destination.parent.create(recursive: true);
      await entity.copy(destination.path);
      output.add({
        'path': relative,
        'size': await destination.length(),
        'sha256': await _bridge.sha256File(destination.path),
      });
    }
    return output;
  }

  Future<void> _deleteEmptyDirectories(Directory root) async {
    final entities = await root
        .list(recursive: true, followLinks: false)
        .toList();
    for (final directory in entities.whereType<Directory>().toList().reversed) {
      await _deleteDirectoryIfExists(directory);
    }
    await _deleteDirectoryIfExists(root);
  }

  Future<void> _deleteFileIfExists(File file) async {
    try {
      if (await file.exists()) {
        await file.delete();
      }
    } catch (_) {
      // Locked or moved files are left in place instead of guessing.
    }
  }

  Future<void> _deleteDirectoryIfExists(
    Directory directory, {
    bool recursive = false,
  }) async {
    try {
      if (await directory.exists()) {
        await directory.delete(recursive: recursive);
      }
    } catch (_) {
      // Non-empty directories are preserved.
    }
  }
}

class InstallResult {
  const InstallResult(
    this.ok,
    this.changed,
    this.message,
    this.installDirectory,
  );

  final bool ok;
  final bool changed;
  final String message;
  final String installDirectory;
}
