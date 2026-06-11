using System.Diagnostics;
using LiveDashboardAgent.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace LiveDashboardAgent.Pages;

public sealed partial class InstallerPage : Page
{
    private InstallScope _lastInstallScope = InstallScope.CurrentUser;
    private bool _isBusy;
    private string? _installedDirectory;

    public InstallerPage()
    {
        InitializeComponent();
        Loaded += (_, _) =>
        {
            InstallPathBox.Text = AppServices.UserInstallService.DefaultDirectory(SelectedScope());
            RefreshInstallAction();
        };
    }

    private async void Install_Click(object sender, RoutedEventArgs e)
    {
        await RunWithBusy(async () =>
        {
            var scope = SelectedScope();
            var installDirectory = InstallPathBox.Text.Trim();
            var result = await AppServices.InstallActionExecutor.Execute(
                InstallAction.Install,
                scope,
                installDirectory,
                createDesktopShortcut: DesktopShortcutCheck.IsChecked == true);
            ShowInstallResult(result);
            if (!result.Ok)
            {
                return;
            }

            _installedDirectory = result.InstallDirectory;
            OpenInstalledButton.Visibility = Visibility.Visible;
            if (LaunchAfterInstallCheck.IsChecked == true)
            {
                OpenInstalled();
                Application.Current.Exit();
            }
        });
    }

    private async void BrowsePath_Click(object sender, RoutedEventArgs e)
    {
        var picker = new FolderPicker
        {
            SuggestedStartLocation = PickerLocationId.ComputerFolder,
        };
        picker.FileTypeFilter.Add("*");
        if (App.MainWindow is not null)
        {
            InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(App.MainWindow));
        }

        var folder = await picker.PickSingleFolderAsync();
        if (folder is null)
        {
            return;
        }
        InstallPathBox.Text = InstallationMode.DirectoryInsideSelectedFolder(folder.Path);
        RefreshInstallAction();
    }

    private void DefaultPath_Click(object sender, RoutedEventArgs e)
    {
        InstallPathBox.Text = AppServices.UserInstallService.DefaultDirectory(SelectedScope());
        RefreshInstallAction();
    }

    private void InstallScope_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (InstallPathBox is null)
        {
            return;
        }

        var scope = SelectedScope();
        var oldDefault = AppServices.UserInstallService.DefaultDirectory(_lastInstallScope);
        if (string.IsNullOrWhiteSpace(InstallPathBox.Text) ||
            string.Equals(InstallPathBox.Text.Trim(), oldDefault, StringComparison.OrdinalIgnoreCase))
        {
            InstallPathBox.Text = AppServices.UserInstallService.DefaultDirectory(scope);
        }
        _lastInstallScope = scope;
        RefreshInstallAction();
    }

    private void InstallPath_TextChanged(object sender, TextChangedEventArgs e)
    {
        RefreshInstallAction();
    }

    private void OpenInstalled_Click(object sender, RoutedEventArgs e)
    {
        OpenInstalled();
        Application.Current.Exit();
    }

    private void Close_Click(object sender, RoutedEventArgs e)
    {
        Application.Current.Exit();
    }

    private void RefreshInstallAction()
    {
        if (InstallHintText is null || InstallPathBox is null)
        {
            return;
        }

        var scope = SelectedScope();
        var directory = InstallPathBox.Text.Trim();
        InstallButton.IsEnabled = !_isBusy;
        if (!InstallDirectorySafety.TryNormalizeDirectory(directory, out _, out var pathError))
        {
            InstallHintText.Text = pathError;
            InstallButton.IsEnabled = false;
            return;
        }

        var elevation = AppServices.UserInstallService.RequiresElevation(scope)
            ? "需要管理员权限"
            : "不需要管理员权限";
        InstallHintText.Text = $"{InstallationMode.LabelFor(scope)} · {elevation} · 选择目录时会自动使用 LiveDashboardAgent 子文件夹";
    }

    private async Task RunWithBusy(Func<Task> action)
    {
        if (_isBusy)
        {
            return;
        }

        SetBusy(true);
        try
        {
            await action();
        }
        finally
        {
            SetBusy(false);
        }
    }

    private void SetBusy(bool busy)
    {
        _isBusy = busy;
        BusyRing.IsActive = busy;
        InstallButton.IsEnabled = !busy;
        BrowsePathButton.IsEnabled = !busy;
        DefaultPathButton.IsEnabled = !busy;
        DesktopShortcutCheck.IsEnabled = !busy;
        LaunchAfterInstallCheck.IsEnabled = !busy;
    }

    private InstallScope SelectedScope()
    {
        if (InstallScopeBox.SelectedItem is ComboBoxItem item &&
            string.Equals(item.Tag?.ToString(), "all-users", StringComparison.OrdinalIgnoreCase))
        {
            return InstallScope.AllUsers;
        }
        return InstallScope.CurrentUser;
    }

    private void ShowInstallResult(InstallResult result)
    {
        StatusBar.Title = "Live Dashboard";
        StatusBar.Message = result.Message;
        StatusBar.Severity = result.Ok ? InfoBarSeverity.Success : InfoBarSeverity.Warning;
        StatusBar.IsOpen = true;
    }

    private void OpenInstalled()
    {
        var directory = _installedDirectory ?? InstallPathBox.Text.Trim();
        var exe = Path.Combine(directory, "LiveDashboardAgent.exe");
        if (!File.Exists(exe))
        {
            ShowInstallResult(new InstallResult(false, false, "已安装程序不存在。", directory));
            return;
        }

        Process.Start(new ProcessStartInfo
        {
            FileName = exe,
            UseShellExecute = true,
        });
    }
}
