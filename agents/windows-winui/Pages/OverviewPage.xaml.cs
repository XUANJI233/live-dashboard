using LiveDashboardAgent.Services;
using LiveDashboardAgent.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace LiveDashboardAgent.Pages;

public sealed partial class OverviewPage : Page
{
    public OverviewPage()
    {
        InitializeComponent();
        Loaded += (_, _) => Refresh();
    }

    private void Refresh_Click(object sender, RoutedEventArgs e)
    {
        Refresh();
    }

    private void Refresh()
    {
        var snapshot = OverviewSnapshot.Create(
            AppServices.ConfigStore.Load(),
            AppServices.StartupManager);

        RuntimeStatusText.Text = snapshot.RuntimeStatus;
        CurrentTargetText.Text = snapshot.CurrentTarget;
        ServerText.Text = snapshot.Server;
        AutostartText.Text = $"自启动: {snapshot.Autostart}";
        DistributionText.Text = snapshot.DistributionMode;
        InstallDirectoryText.Text = snapshot.InstallDirectory;
        CommandLineText.Text = snapshot.CommandLine;
    }
}
