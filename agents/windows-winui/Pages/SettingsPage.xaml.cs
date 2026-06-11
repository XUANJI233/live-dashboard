using LiveDashboardAgent.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace LiveDashboardAgent.Pages;

public sealed partial class SettingsPage : Page
{
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
            LoadConfig();
            ShowStatus("Live Dashboard", "配置已保存。", InfoBarSeverity.Success);
        }
        catch (Exception ex)
        {
            ShowStatus("保存失败", ex.Message, InfoBarSeverity.Error);
        }
    }

    private void ToggleAutostart_Click(object sender, RoutedEventArgs e)
    {
        var result = AppServices.StartupManager.Toggle();
        RefreshAutostart();
        ShowStatus("Live Dashboard", result.Message, result.Ok ? InfoBarSeverity.Success : InfoBarSeverity.Warning);
    }

    private void Install_Click(object sender, RoutedEventArgs e)
    {
        var result = AppServices.UserInstallService.InstallCurrentUser();
        RefreshInstallAction();
        RefreshAutostart();
        ShowStatus("Live Dashboard", result.Message, result.Ok ? InfoBarSeverity.Success : InfoBarSeverity.Warning);
    }

    private void Reload_Click(object sender, RoutedEventArgs e)
    {
        LoadConfig();
        ShowStatus("Live Dashboard", "配置已重新载入。", InfoBarSeverity.Informational);
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
        ModeText.Text = InstallationMode.Label;
        RefreshInstallAction();
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

    private void RefreshInstallAction()
    {
        var installMode = InstallationMode.Current == AgentDistributionMode.UserInstall;
        InstallButton.IsEnabled = installMode && !AppServices.UserInstallService.IsRunningFromInstallDirectory();
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
