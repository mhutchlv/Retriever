using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AirPlay.Windows.Settings;

public enum AspectMode
{
    /// <summary>Keep the aspect ratio, letterbox as needed.</summary>
    Fit,

    /// <summary>Keep the aspect ratio, crop to fill the window.</summary>
    Fill,

    /// <summary>Ignore the aspect ratio.</summary>
    Stretch,
}

/// <summary>User settings, stored as JSON under %APPDATA%\AirPlayReceiver.</summary>
public sealed class AppSettings
{
    public static string Directory { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AirPlayReceiver");
    public static string FilePath { get; } = Path.Combine(Directory, "settings.json");
    public static string IdentityPath { get; } = Path.Combine(Directory, "identity.key");

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    public string ReceiverName { get; set; } = Environment.MachineName;
    public string? Password { get; set; }
    public bool AlwaysOnTop { get; set; }
    public AspectMode AspectMode { get; set; } = AspectMode.Fit;
    public bool StartWithWindows { get; set; }
    public bool MinimizeToTray { get; set; } = true;
    public bool StartMinimized { get; set; }
    public bool EnableAudio { get; set; } = true;
    public bool SupportHevc { get; set; }
    public bool AllowTakeover { get; set; } = true;
    public bool VerboseLogging { get; set; }
    public int RtspPort { get; set; } = 7000;
    public int MirrorDataPort { get; set; } = 7100;
    public int AudioDataPort { get; set; } = 6000;
    public int AudioControlPort { get; set; } = 6001;
    public int TimingPort { get; set; } = 7011;
    public double WindowWidth { get; set; } = 540;
    public double WindowHeight { get; set; } = 960;
    public string? ScreenshotFolder { get; set; }
    public string? RecordingFolder { get; set; }

    public static AppSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath), JsonOptions) ?? new AppSettings();
            }
        }
        catch (Exception)
        {
            // Corrupt settings: start fresh rather than refuse to launch.
        }

        return new AppSettings();
    }

    public void Save()
    {
        System.IO.Directory.CreateDirectory(Directory);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, JsonOptions));
    }

    public AppSettings Clone() => (AppSettings)MemberwiseClone();

    public ReceiverOptions ToReceiverOptions() => new()
    {
        Name = string.IsNullOrWhiteSpace(ReceiverName) ? Environment.MachineName : ReceiverName.Trim(),
        Password = string.IsNullOrEmpty(Password) ? null : Password,
        RtspPort = RtspPort,
        MirrorDataPort = MirrorDataPort,
        AudioDataPort = AudioDataPort,
        AudioControlPort = AudioControlPort,
        TimingPort = TimingPort,
        IdentityFile = IdentityPath,
        SupportHevc = SupportHevc,
        AllowTakeover = AllowTakeover,
    };
}
