import 'dart:io';

class InstallDirectorySafety {
  static const markerFileName = '.live-dashboard-agent-install';
  static const defaultFolderName = 'LiveDashboardAgent';

  static String directoryInsideSelectedFolder(String folder) {
    final normalized = normalize(folder);
    if (normalized.split(Platform.pathSeparator).last.toLowerCase() ==
        defaultFolderName.toLowerCase()) {
      return normalized;
    }
    return '$normalized${Platform.pathSeparator}$defaultFolderName';
  }

  static String normalize(String path) {
    return path.trim().replaceAll(RegExp(r'[\\/]+$'), '');
  }

  static String? validateInstallTarget(String path) {
    final normalized = normalize(path);
    if (normalized.isEmpty) {
      return '安装路径不能为空';
    }
    final root = Directory(normalized).absolute.uri.resolve('.').toFilePath();
    final segments = normalized
        .replaceAll('/', '\\')
        .split('\\')
        .where((part) => part.isNotEmpty)
        .toList();
    if (segments.length <= 1 || RegExp(r'^[A-Za-z]:$').hasMatch(normalized)) {
      return '安装路径不能是磁盘根目录';
    }
    if (!normalized.toLowerCase().endsWith(
      '\\${defaultFolderName.toLowerCase()}',
    )) {
      return '请选择或使用 $defaultFolderName 子文件夹';
    }
    if (root.length <= 4) {
      return '安装路径过短，已拒绝';
    }
    return null;
  }

  static bool isChildOrSame(String parent, String child) {
    final a = '${normalize(parent).toLowerCase()}\\';
    final b = '${normalize(child).toLowerCase()}\\';
    return b.startsWith(a) || a.startsWith(b);
  }
}
