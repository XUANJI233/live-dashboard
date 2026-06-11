using Microsoft.UI.Xaml;
using LiveDashboardAgent.Services;

namespace LiveDashboardAgent;

public partial class App : Application
{
    private Window? _window;
    private SingleInstanceService? _singleInstance;

    public static Window? MainWindow { get; private set; }

    public App()
    {
        InitializeComponent();
    }

    protected override void OnLaunched(Microsoft.UI.Xaml.LaunchActivatedEventArgs args)
    {
        if (InstallCommandRunner.TryRun(CommandLineArgumentParser.Parse(args.Arguments)) ||
            InstallCommandRunner.TryRun(Environment.GetCommandLineArgs().Skip(1).ToArray()))
        {
            Exit();
            return;
        }

        AppServices.LegacyAgentCleanup.Run();

        _singleInstance = new SingleInstanceService();
        if (_singleInstance.AlreadyRunning)
        {
            _singleInstance.NotifyExisting();
            _singleInstance.Dispose();
            Exit();
            return;
        }

        _window = new MainWindow(_singleInstance);
        MainWindow = _window;
        _window.Activate();
    }
}
