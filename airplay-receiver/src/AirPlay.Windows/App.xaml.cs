using System.IO;
using System.Windows;
using System.Windows.Threading;
using AirPlay.Windows.Settings;

namespace AirPlay.Windows;

public partial class App : Application
{
    private static readonly object LogLock = new();
    private static StreamWriter? _logFile;

    public static AppSettings Settings { get; private set; } = new();

    /// <summary>Swaps in a saved copy of the settings (from the settings dialog).</summary>
    public static void ReplaceSettings(AppSettings settings) => Settings = settings;
    public static Log Log { get; private set; } = Log.Null;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        Settings = AppSettings.Load();
        Log = CreateLog(Settings.VerboseLogging);
        Log.Info($"AirPlay Receiver starting ({Environment.OSVersion}, .NET {Environment.Version})");

        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) => Log.Error($"Unhandled: {args.ExceptionObject}");
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            Log.Error($"Unobserved task exception: {args.Exception}");
            args.SetObserved();
        };

        var startMinimized = e.Args.Contains("--minimized", StringComparer.OrdinalIgnoreCase) || Settings.StartMinimized;
        var window = new MainWindow(startMinimized);
        MainWindow = window;
        if (!startMinimized || !Settings.MinimizeToTray)
        {
            window.Show();
            if (startMinimized)
            {
                window.WindowState = WindowState.Minimized;
            }
        }
    }

    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        Log.Error($"UI exception: {e.Exception}");
        MessageBox.Show(e.Exception.Message, "AirPlay Receiver", MessageBoxButton.OK, MessageBoxImage.Error);
        e.Handled = true;
    }

    public static Log CreateLog(bool verbose)
    {
        try
        {
            Directory.CreateDirectory(AppSettings.Directory);
            _logFile?.Dispose();
            _logFile = new StreamWriter(Path.Combine(AppSettings.Directory, "receiver.log"), append: false) { AutoFlush = true };
        }
        catch
        {
            _logFile = null;
        }

        return new Log((level, message) =>
        {
            var line = $"{DateTime.Now:HH:mm:ss.fff} [{level,-7}] {message}";
            System.Diagnostics.Debug.WriteLine(line);
            lock (LogLock)
            {
                _logFile?.WriteLine(line);
            }

            LogLine?.Invoke(level, line);
        }, verbose ? LogLevel.Debug : LogLevel.Info);
    }

    /// <summary>Lets the main window show recent log lines in its status area.</summary>
    public static event Action<LogLevel, string>? LogLine;

    protected override void OnExit(ExitEventArgs e)
    {
        Log.Info("Exiting");
        _logFile?.Dispose();
        base.OnExit(e);
    }
}
