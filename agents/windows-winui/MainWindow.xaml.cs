using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using LiveDashboardAgent.Pages;
using LiveDashboardAgent.Services;
using WinRT.Interop;

namespace LiveDashboardAgent;

public sealed partial class MainWindow : Window
{
    private readonly SingleInstanceService _singleInstance;
    private TrayIconService? _trayIcon;
    private WindowMessageRouter? _messageRouter;
    private WindowCloseInterceptor? _closeInterceptor;
    private bool _allowClose;
    private bool _hideToTrayEnabled;
    private bool _updatingNavigationSelection;
    private bool _startAgentShellOnActivated;
    private bool _agentShellStarted;

    public MainWindow(SingleInstanceService singleInstance)
    {
        _singleInstance = singleInstance;
        InitializeComponent();
        Activated += MainWindow_Activated;
        AppWindow.Closing += MainWindow_Closing;
        Closed += MainWindow_Closed;
        _singleInstance.StartActivationListener(() =>
        {
            DispatcherQueue.TryEnqueue(ShowMainWindow);
        });

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        AppWindow.SetIcon(AppIconPath.Resolve());
        if (AppServices.UserInstallService.ShouldShowInstallerOnLaunch())
        {
            ShowInstaller();
        }
        else
        {
            _startAgentShellOnActivated = true;
        }
    }

    private void TitleBar_PaneToggleRequested(TitleBar sender, object args)
    {
        NavView.IsPaneOpen = !NavView.IsPaneOpen;
    }

    private void NavView_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (_updatingNavigationSelection)
        {
            return;
        }

        if (args.SelectedItem is NavigationViewItem item)
        {
            NavigateTo(item.Tag?.ToString() ?? "");
        }
    }

    private void MainWindow_Closing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (!_hideToTrayEnabled || _allowClose)
        {
            return;
        }

        args.Cancel = true;
        WindowActivation.Hide(this);
    }

    private void MainWindow_Closed(object sender, WindowEventArgs args)
    {
        _closeInterceptor?.Dispose();
        _closeInterceptor = null;
        _trayIcon?.Dispose();
        _trayIcon = null;
        _messageRouter?.Dispose();
        _messageRouter = null;
        AppServices.AgentRuntime.Stop();
        _singleInstance.Dispose();
    }

    private void MainWindow_Activated(object sender, WindowActivatedEventArgs args)
    {
        if (!_startAgentShellOnActivated || _agentShellStarted)
        {
            return;
        }

        _agentShellStarted = true;
        ShowAgentShell();
    }

    private void ShowAgentShell()
    {
        _hideToTrayEnabled = true;
        TryCreateCloseInterceptor();
        TryCreateTrayIcon();
        AppServices.AgentRuntime.Start(AppServices.ConfigStore.Load());
        NavigateTo(NavigationRoutes.Overview);
    }

    private void TryCreateCloseInterceptor()
    {
        if (_closeInterceptor is not null)
        {
            return;
        }

        try
        {
            var router = EnsureMessageRouter();
            _closeInterceptor = new WindowCloseInterceptor(
                router,
                () => _hideToTrayEnabled && !_allowClose,
                () => WindowActivation.Hide(this));
        }
        catch
        {
            _closeInterceptor = null;
        }
    }

    private void TryCreateTrayIcon()
    {
        try
        {
            var router = EnsureMessageRouter();
            _trayIcon = new TrayIconService(
                router,
                () => DispatcherQueue.TryEnqueue(ShowMainWindow),
                () => DispatcherQueue.TryEnqueue(() =>
                {
                    ShowMainWindow();
                    NavigateTo(NavigationRoutes.Settings);
                }),
                () => DispatcherQueue.TryEnqueue(ExitApplication));
        }
        catch
        {
            _trayIcon = null;
        }
    }

    private WindowMessageRouter EnsureMessageRouter()
    {
        return _messageRouter ??= new WindowMessageRouter(WindowNative.GetWindowHandle(this));
    }

    private void ShowMainWindow()
    {
        WindowActivation.ShowAndActivate(this);
    }

    private void ExitApplication()
    {
        _allowClose = true;
        Close();
        Application.Current.Exit();
    }

    private void NavigateTo(string route)
    {
        var pageType = route switch
        {
            NavigationRoutes.Overview => typeof(OverviewPage),
            NavigationRoutes.Messages => typeof(MessagesPage),
            NavigationRoutes.Settings => typeof(SettingsPage),
            _ => throw new InvalidOperationException($"Unknown navigation item tag: {route}"),
        };

        if (NavFrame.CurrentSourcePageType != pageType)
        {
            NavFrame.Navigate(pageType);
        }
        NavFrame.BackStack.Clear();

        SelectNavigationItem(route);
    }

    private void SelectNavigationItem(string route)
    {
        var item = NavView.MenuItems
            .OfType<NavigationViewItem>()
            .FirstOrDefault(menuItem => string.Equals(
                menuItem.Tag?.ToString(),
                route,
                StringComparison.OrdinalIgnoreCase));
        if (item is null || ReferenceEquals(NavView.SelectedItem, item))
        {
            return;
        }

        _updatingNavigationSelection = true;
        try
        {
            NavView.SelectedItem = item;
        }
        finally
        {
            _updatingNavigationSelection = false;
        }
    }

    private void ShowInstaller()
    {
        Title = "Live Dashboard 安装";
        AppWindow.Title = "Live Dashboard 安装";
        AppTitleBar.Title = "Live Dashboard 安装";
        AppTitleBar.IsPaneToggleButtonVisible = false;
        NavView.IsPaneVisible = false;
        NavFrame.Navigate(typeof(InstallerPage));
        NavFrame.BackStack.Clear();
    }
}
