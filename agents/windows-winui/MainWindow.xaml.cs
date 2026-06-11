using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using LiveDashboardAgent.Pages;
using LiveDashboardAgent.Services;

namespace LiveDashboardAgent;

public sealed partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        AppWindow.SetIcon("Assets/AppIcon.ico");
        if (AppServices.UserInstallService.ShouldShowInstallerOnLaunch())
        {
            ShowInstaller();
        }
        else
        {
            NavFrame.Navigate(typeof(OverviewPage));
        }
    }

    private void TitleBar_PaneToggleRequested(TitleBar sender, object args)
    {
        NavView.IsPaneOpen = !NavView.IsPaneOpen;
    }

    private void TitleBar_BackRequested(TitleBar sender, object args)
    {
        NavFrame.GoBack();
    }

    private void NavView_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (args.SelectedItem is NavigationViewItem item)
        {
            switch (item.Tag)
            {
                case NavigationRoutes.Overview:
                    NavFrame.Navigate(typeof(OverviewPage));
                    break;
                case NavigationRoutes.Messages:
                    NavFrame.Navigate(typeof(MessagesPage));
                    break;
                case NavigationRoutes.Settings:
                    NavFrame.Navigate(typeof(SettingsPage));
                    break;
                default:
                    throw new InvalidOperationException($"Unknown navigation item tag: {item.Tag}");
            }
        }
    }

    private void ShowInstaller()
    {
        AppTitleBar.Title = "Live Dashboard 安装";
        AppTitleBar.IsPaneToggleButtonVisible = false;
        NavView.IsPaneVisible = false;
        NavFrame.Navigate(typeof(InstallerPage));
    }
}
