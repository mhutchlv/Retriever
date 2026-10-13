using System.Globalization;
using AirPlay;
using AirPlay.Streams;

// Headless receiver: useful to validate discovery and the protocol on any OS, and to capture
// a raw H.264 stream (play it back with: ffplay -f h264 capture.h264).

var options = new ReceiverOptions();
string? dumpPath = null;
var level = LogLevel.Info;
var quietFrames = false;

for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "-n":
        case "--name":
            options.Name = args[++i];
            break;
        case "-p":
        case "--password":
            options.Password = args[++i];
            break;
        case "--port":
            options.RtspPort = int.Parse(args[++i], CultureInfo.InvariantCulture);
            break;
        case "--dump-h264":
            dumpPath = args[++i];
            break;
        case "--hevc":
            options.SupportHevc = true;
            break;
        case "--identity":
            options.IdentityFile = args[++i];
            break;
        case "--no-takeover":
            options.AllowTakeover = false;
            break;
        case "-v":
        case "--verbose":
            level = LogLevel.Debug;
            break;
        case "-q":
        case "--quiet-frames":
            quietFrames = true;
            break;
        case "-h":
        case "--help":
            Console.WriteLine("airplay-host [--name NAME] [--password PW] [--port 7000] [--dump-h264 FILE] [--hevc] [--identity FILE] [--no-takeover] [-v] [-q]");
            return 0;
        default:
            Console.Error.WriteLine($"Unknown argument {args[i]}");
            return 2;
    }
}

options.IdentityFile ??= Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AirPlayReceiver", "identity.key");

var log = Log.Console(level);
using var receiver = new AirPlayReceiver(options, log);
FileStream? dump = dumpPath != null ? File.Create(dumpPath) : null;
long frames = 0;
long bytes = 0;
var lastReport = DateTime.UtcNow;

receiver.ClientConnected += c => log.Info($"*** {c} connected");
receiver.ClientDisconnected += (c, why) => log.Info($"*** {c} disconnected: {why}");
receiver.VideoCodecData += d => log.Info($"*** video codec {d.Codec} {d.Width}x{d.Height}, parameter sets {Hex.Dump(d.ParameterSets, 48)}");
receiver.VideoFrame += f =>
{
    frames++;
    bytes += f.Length;
    dump?.Write(f.Span);
    if (!quietFrames && (f.IsKeyframe || DateTime.UtcNow - lastReport > TimeSpan.FromSeconds(2)))
    {
        var offset = receiver.ClientClockOffsetSeconds;
        var latency = offset == null ? "n/a" : $"{(Ntp.ToSeconds(Ntp.LocalNow()) + offset.Value - Ntp.ToSeconds(f.NtpTimestamp)) * 1000:F0} ms";
        log.Info($"video: {frames} frames, {bytes / 1024} KiB, last {f.Length} bytes{(f.IsKeyframe ? " (keyframe)" : "")}, est. latency {latency}");
        lastReport = DateTime.UtcNow;
    }
};
receiver.VideoPaused += () => log.Info("*** video paused by client");
receiver.VideoResumed += () => log.Info("*** video resumed");
receiver.VideoStopped += () => log.Info("*** video stopped");
receiver.AudioStarted += a => log.Info($"*** audio {a.Codec} spf={a.SamplesPerFrame} format=0x{a.AudioFormat:x}");
receiver.VolumeChanged += v => log.Info($"*** volume {v:F1} dB");
receiver.StreamError += e => log.Warn($"*** stream error: {e}");

receiver.Start();
log.Info($"Open Control Center on the iPhone, tap Screen Mirroring and choose \"{options.Name}\". Press Ctrl+C to stop.");
if (dump != null)
{
    log.Info($"Writing raw H.264 to {dumpPath}");
}

var done = new ManualResetEventSlim();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    done.Set();
};
AppDomain.CurrentDomain.ProcessExit += (_, _) => done.Set();
done.Wait();
receiver.Stop();
dump?.Dispose();
log.Info("Stopped.");
return 0;
