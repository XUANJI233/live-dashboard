enum AppDistribution {
  portable,
  userInstall;

  static const current =
      String.fromEnvironment('LIVE_DASHBOARD_DISTRIBUTION') == 'user_install'
      ? AppDistribution.userInstall
      : AppDistribution.portable;
}

enum InstallScope {
  currentUser,
  allUsers;

  String get label => switch (this) {
    InstallScope.currentUser => '当前用户',
    InstallScope.allUsers => '所有用户',
  };

  String get registryValue => switch (this) {
    InstallScope.currentUser => 'current_user',
    InstallScope.allUsers => 'all_users',
  };
}
