using LiveDashboardAgent.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace LiveDashboardAgent.Pages;

public sealed partial class SettingsPage : Page
{
    private bool _isBusy;

    public SettingsPage()
    {
        InitializeComponent();
        Loaded += (_, _) => LoadConfig();
    }

    private void Save_Click(object sender, RoutedEventArgs e)
    {
        var config = FormConfig();
        var error = config.Validate();
        if (error is not null)
        {
            ShowStatus("配置错误", error, InfoBarSeverity.Error);
            return;
        }

        try
        {
            AppServices.ConfigStore.Save(config);
            AppServices.AgentRuntime.Restart(config);
            LoadConfig();
            ShowStatus("Live Dashboard", "配置已保存。", InfoBarSeverity.Success);
        }
        catch (Exception ex)
        {
            ShowStatus("保存失败", ex.Message, InfoBarSeverity.Error);
        }
    }

    private async void ToggleAutostart_Click(object sender, RoutedEventArgs e)
    {
        await RunWithBusy(async () =>
        {
            var result = await Task.Run(() => AppServices.StartupManager.Toggle());
            RefreshAutostart();
            ShowStatus("Live Dashboard", result.Message, result.Ok ? InfoBarSeverity.Success : InfoBarSeverity.Warning);
        });
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
        SaveButton.IsEnabled = !busy;
        ToggleAutostartButton.IsEnabled = !busy;
    }

    private void Reload_Click(object sender, RoutedEventArgs e)
    {
        LoadConfig();
        ShowStatus("Live Dashboard", "配置已重新载入。", InfoBarSeverity.Informational);
    }

    private void OpenLog_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            AgentLogService.OpenLogFile();
        }
        catch (Exception ex)
        {
            ShowStatus("打开失败", ex.Message, InfoBarSeverity.Error);
        }
    }

    private void OpenLogFolder_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            AgentLogService.OpenLogFolder();
        }
        catch (Exception ex)
        {
            ShowStatus("打开失败", ex.Message, InfoBarSeverity.Error);
        }
    }

    private void LoadConfig()
    {
        var config = AppServices.ConfigStore.Load();
        RegistryPathText.Text = $@"HKCU\{RegistryConfigStore.RegistryPath}";
        ServerUrlBox.Text = config.ServerUrl;
        TokenBox.Password = config.Token;
        IntervalBox.Value = config.IntervalSeconds;
        HeartbeatBox.Value = config.HeartbeatSeconds;
        IdleBox.Value = config.IdleThresholdSeconds;
        EnableLogSwitch.IsOn = config.EnableLog;
        var install = AppServices.UserInstallService.GetRunningInstall();
        ModeText.Text = install is null
            ? InstallationMode.Label
            : $"{InstallationMode.LabelFor(install.Scope)}安装版";
        RefreshAutostart();
    }

    private AppConfig FormConfig()
    {
        return new AppConfig
        {
            ServerUrl = ServerUrlBox.Text,
            Token = TokenBox.Password,
            IntervalSeconds = NumberValue(IntervalBox, AppConfig.Default.IntervalSeconds),
            HeartbeatSeconds = NumberValue(HeartbeatBox, AppConfig.Default.HeartbeatSeconds),
            IdleThresholdSeconds = NumberValue(IdleBox, AppConfig.Default.IdleThresholdSeconds),
            EnableLog = EnableLogSwitch.IsOn,
        }.Normalize();
    }

    private void RefreshAutostart()
    {
        AutostartStatusText.Text = AppServices.StartupManager.IsEnabled()
            ? "自启动: 已开启"
            : "自启动: 未开启";
    }

    private void ShowStatus(string title, string message, InfoBarSeverity severity)
    {
        StatusBar.Title = title;
        StatusBar.Message = message;
        StatusBar.Severity = severity;
        StatusBar.IsOpen = true;
    }

    private static int NumberValue(NumberBox box, int fallback)
    {
        return double.IsNaN(box.Value) ? fallback : (int)Math.Round(box.Value);
    }
}
