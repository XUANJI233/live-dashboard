using LiveDashboardAgent.Services;
using LiveDashboardAgent.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace LiveDashboardAgent.Pages;

public sealed partial class OverviewPage : Page
{
    private readonly DispatcherTimer _refreshTimer = new()
    {
        Interval = TimeSpan.FromSeconds(2),
    };

    public OverviewPage()
    {
        InitializeComponent();
        Loaded += OverviewPage_Loaded;
        Unloaded += (_, _) => _refreshTimer.Stop();
        _refreshTimer.Tick += (_, _) => Refresh();
    }

    private void Refresh_Click(object sender, RoutedEventArgs e)
    {
        Refresh();
    }

    private void OpenLog_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            AgentLogService.OpenLogFile();
        }
        catch
        {
            // Settings page can show detailed errors; overview keeps the action non-disruptive.
        }
    }

    private void OpenLogFolder_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            AgentLogService.OpenLogFolder();
        }
        catch
        {
            // Overview keeps secondary actions non-disruptive.
        }
    }

    private void OverviewPage_Loaded(object sender, RoutedEventArgs e)
    {
        Refresh();
        _refreshTimer.Start();
    }

    private void Refresh()
    {
        var snapshot = OverviewSnapshot.Create(
            AppServices.ConfigStore.Load(),
            AppServices.StartupManager,
            AppServices.AgentRuntime.Snapshot);

        RuntimeStatusText.Text = snapshot.RuntimeStatus;
        CurrentTargetText.Text = snapshot.CurrentTarget;
        ServerText.Text = snapshot.Server;
        AutostartText.Text = $"自启动: {snapshot.Autostart}";
        DistributionText.Text = snapshot.DistributionMode;
        InstallDirectoryText.Text = snapshot.RuntimeDirectory;
        CommandLineText.Text = snapshot.CommandLine;
    }
}
