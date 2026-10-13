namespace AirPlay;

public enum LogLevel
{
    Debug = 0,
    Info = 1,
    Warning = 2,
    Error = 3,
}

/// <summary>Minimal logging facade so the core has no logging-framework dependency.</summary>
public sealed class Log
{
    private readonly Action<LogLevel, string> _sink;

    public Log(Action<LogLevel, string> sink, LogLevel minimum = LogLevel.Info)
    {
        _sink = sink;
        Minimum = minimum;
    }

    public static Log Null { get; } = new((_, _) => { }, LogLevel.Error);

    public static Log Console(LogLevel minimum = LogLevel.Info) => new((level, message) =>
    {
        var line = $"{DateTime.Now:HH:mm:ss.fff} [{level,-7}] {message}";
        if (level >= LogLevel.Warning)
        {
            System.Console.Error.WriteLine(line);
        }
        else
        {
            System.Console.WriteLine(line);
        }
    }, minimum);

    public LogLevel Minimum { get; set; }

    public bool IsEnabled(LogLevel level) => level >= Minimum;

    public void Write(LogLevel level, string message)
    {
        if (level >= Minimum)
        {
            _sink(level, message);
        }
    }

    public void Debug(string message) => Write(LogLevel.Debug, message);
    public void Info(string message) => Write(LogLevel.Info, message);
    public void Warn(string message) => Write(LogLevel.Warning, message);
    public void Error(string message) => Write(LogLevel.Error, message);
}
