using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text;
using AirPlay.Dns;
using AirPlay.FairPlay;
using AirPlay.Pairing;
using AirPlay.Rtsp;
using AirPlay.Session;
using AirPlay.Streams;

namespace AirPlay;

/// <summary>
/// The AirPlay screen-mirroring receiver: advertises itself over mDNS, speaks the AirPlay
/// control protocol on the RTSP port, and raises events with decrypted video and audio.
/// Events are raised on protocol threads; consumers must marshal to their own threads.
/// </summary>
public sealed class AirPlayReceiver : IDisposable
{
    private readonly Log _log;
    private readonly RequestRouter _router;
    private readonly object _sessionLock = new();
    private RtspServer? _rtsp;
    private MdnsResponder? _mdns;
    private Timer? _watchdog;
    private AirPlayConnection? _active;
    private IFairPlayDecryptor? _fairPlay;

    public AirPlayReceiver(ReceiverOptions options, Log? log = null)
    {
        Options = options;
        _log = log ?? Log.Null;
        _router = new RequestRouter(this, _log);
        MacAddress = options.MacAddress ?? DetectMacAddress(_log);
        Identity = options.Identity
                   ?? (options.IdentityFile != null ? ReceiverIdentity.LoadOrCreate(options.IdentityFile, _log) : ReceiverIdentity.FromDeviceId(Hex.MacColon(MacAddress)));
        AirPlayService = BuildAirPlayService();
        RaopService = BuildRaopService();
    }

    public ReceiverOptions Options { get; }
    public byte[] MacAddress { get; }
    public ReceiverIdentity Identity { get; }
    public MdnsService AirPlayService { get; private set; }
    public MdnsService RaopService { get; private set; }
    public bool IsRunning => _rtsp != null;
    public int RtspPort => _rtsp?.Port ?? Options.RtspPort;

    /// <summary>The device currently mirroring, if any.</summary>
    public ClientInfo? ActiveClient
    {
        get
        {
            lock (_sessionLock)
            {
                return _active?.Client;
            }
        }
    }

    public event Action<ClientInfo>? ClientConnected;
    public event Action<ClientInfo, string>? ClientDisconnected;
    public event Action<VideoCodecData>? VideoCodecData;
    public event Action<VideoFrame>? VideoFrame;
    public event Action? VideoPaused;
    public event Action? VideoResumed;
    public event Action? VideoStopped;
    public event Action<AudioStreamInfo>? AudioStarted;
    public event Action<AudioFrame>? AudioFrame;
    public event Action<AudioSync>? AudioSync;
    public event Action<double>? VolumeChanged;
    public event Action<string, byte[]>? ArtworkReceived;
    public event Action<byte[]>? MetadataReceived;
    public event Action<string>? StreamError;

    public void Start()
    {
        if (_rtsp != null)
        {
            return;
        }

        _fairPlay = Options.FairPlayDecryptor ?? new NativePlayfair();
        if (_fairPlay is NativePlayfair && !NativePlayfair.IsAvailable)
        {
            _log.Error("playfair native library not found: sessions will fail at SETUP. See native/README.md.");
        }

        AirPlayService = BuildAirPlayService();
        RaopService = BuildRaopService();

        var server = new RtspServer(_log, _router.HandleAsync);
        server.ConnectionOpened += OnConnectionOpened;
        server.ConnectionClosed += OnConnectionClosed;
        server.Start(Options.RtspPort);
        _rtsp = server;

        if (server.Port != Options.RtspPort)
        {
            AirPlayService = BuildAirPlayService(server.Port);
            RaopService = BuildRaopService(server.Port);
        }

        if (Options.AdvertiseOverMdns)
        {
            var mdns = new MdnsResponder(_log, HostName, new[] { AirPlayService, RaopService });
            mdns.Start();
            _mdns = mdns;
        }
        _watchdog = new Timer(_ => Watchdog(), null, 5000, 5000);
        _log.Info($"Receiver '{Options.Name}' ready (deviceid {Hex.MacColon(MacAddress)}, pk {Identity.PublicKeyHex[..16]}...)");
    }

    public void Stop()
    {
        _watchdog?.Dispose();
        _watchdog = null;
        AirPlayConnection? active;
        lock (_sessionLock)
        {
            active = _active;
            _active = null;
        }

        if (active != null)
        {
            active.TearDown();
            RaiseDisconnected(active, "receiver stopped");
        }

        _mdns?.Dispose();
        _mdns = null;
        _rtsp?.Dispose();
        _rtsp = null;
    }

    public void Dispose() => Stop();

    /// <summary>Ends the current session (if any) from the receiver side.</summary>
    public void DisconnectClient()
    {
        AirPlayConnection? active;
        lock (_sessionLock)
        {
            active = _active;
        }

        if (active != null)
        {
            EndSession(active, "disconnected by the receiver");
            active.Rtsp.Close();
        }
    }

    public string HostName => "airplay-" + Hex.MacPlain(MacAddress).ToLowerInvariant() + ".local";

    // ---------------------------------------------------------------- mDNS records

    private MdnsService BuildAirPlayService(int? port = null)
    {
        var txt = new List<KeyValuePair<string, string>>
        {
            new("deviceid", Hex.MacColon(MacAddress)),
            new("features", Options.FeaturesText),
            new("pw", string.IsNullOrEmpty(Options.Password) ? "false" : "true"),
            new("flags", "0x4"),
            new("model", Options.Model),
            new("pk", Identity.PublicKeyHex),
            new("pi", Options.PairingIdentifier),
            new("srcvers", Options.SourceVersion),
            new("vv", "2"),
        };
        return new MdnsService("_airplay._tcp.local", Options.Name, (ushort)(port ?? Options.RtspPort), txt);
    }

    private MdnsService BuildRaopService(int? port = null)
    {
        var hasPassword = !string.IsNullOrEmpty(Options.Password);
        var txt = new List<KeyValuePair<string, string>>
        {
            new("ch", "2"),
            new("cn", "0,1,2,3"),
            new("da", "true"),
            new("et", "0,3,5"),
            new("vv", "2"),
            new("ft", Options.FeaturesText),
            new("am", Options.Model),
            new("md", "0,1,2"),
            new("rhd", "5.6.0.0"),
            new("pw", hasPassword ? "true" : "false"),
            new("sr", "44100"),
            new("ss", "16"),
            new("sv", "false"),
            new("tp", "UDP"),
            new("txtvers", "1"),
            new("sf", hasPassword ? "0x84" : "0x4"),
            new("vs", Options.SourceVersion),
            new("vn", "65537"),
            new("pk", Identity.PublicKeyHex),
        };
        var instance = Hex.MacPlain(MacAddress) + "@" + Options.Name;
        return new MdnsService("_raop._tcp.local", instance, (ushort)(port ?? Options.RtspPort), txt);
    }

    private static byte[] DetectMacAddress(Log log)
    {
        try
        {
            var candidates = NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.NetworkInterfaceType != NetworkInterfaceType.Loopback && n.NetworkInterfaceType != NetworkInterfaceType.Tunnel)
                .OrderByDescending(n => n.OperationalStatus == OperationalStatus.Up)
                .ThenByDescending(n => n.NetworkInterfaceType == NetworkInterfaceType.Ethernet || n.NetworkInterfaceType == NetworkInterfaceType.Wireless80211)
                .Select(n => n.GetPhysicalAddress().GetAddressBytes())
                .Where(b => b.Length == 6 && b.Any(x => x != 0));
            var mac = candidates.FirstOrDefault();
            if (mac != null)
            {
                return mac;
            }
        }
        catch (Exception ex)
        {
            log.Debug($"MAC detection failed: {ex.Message}");
        }

        // Stable fallback: hash of the machine name, with the locally-administered bit set.
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(Environment.MachineName));
        var fallback = hash[..6];
        fallback[0] = (byte)((fallback[0] | 0x02) & 0xFE);
        return fallback;
    }

    // ---------------------------------------------------------------- connection lifecycle

    private void OnConnectionOpened(RtspConnection rtsp)
    {
        rtsp.State = new AirPlayConnection(rtsp, Identity, _fairPlay ?? new NativePlayfair());
    }

    private void OnConnectionClosed(RtspConnection rtsp)
    {
        if (rtsp.State is AirPlayConnection conn)
        {
            EndSession(conn, "connection closed");
            conn.Dispose();
        }
    }

    /// <summary>Makes <paramref name="conn"/> the active session, evicting another client if allowed.</summary>
    internal bool TryClaimSession(AirPlayConnection conn)
    {
        AirPlayConnection? evicted = null;
        lock (_sessionLock)
        {
            if (_active != null && _active != conn)
            {
                if (!Options.AllowTakeover && _active.Rtsp.IsConnected)
                {
                    return false;
                }

                evicted = _active;
            }

            _active = conn;
        }

        if (evicted != null)
        {
            _log.Info($"Replacing session of {evicted.Client} with a new client.");
            evicted.TearDown();
            RaiseDisconnected(evicted, "replaced by another device");
            evicted.Rtsp.Close();
        }

        return true;
    }

    internal void OnSessionStarted(AirPlayConnection conn)
    {
        var client = conn.Client!;
        try
        {
            ClientConnected?.Invoke(client);
        }
        catch (Exception ex)
        {
            _log.Error($"ClientConnected handler failed: {ex}");
        }
    }

    internal void EndSession(AirPlayConnection conn, string reason)
    {
        var wasActive = false;
        lock (_sessionLock)
        {
            if (_active == conn)
            {
                _active = null;
                wasActive = true;
            }
        }

        var hadSession = conn.HasSession;
        conn.TearDown();
        if (wasActive && hadSession)
        {
            RaiseDisconnected(conn, reason);
        }
    }

    private void RaiseDisconnected(AirPlayConnection conn, string reason)
    {
        var client = conn.Client ?? new ClientInfo { Address = conn.Rtsp.RemoteAddress };
        _log.Info($"Session with {client} ended: {reason}");
        try
        {
            VideoStopped?.Invoke();
            ClientDisconnected?.Invoke(client, reason);
        }
        catch (Exception ex)
        {
            _log.Error($"ClientDisconnected handler failed: {ex}");
        }
    }

    internal void TouchSession(AirPlayConnection conn) => conn.Rtsp.LastActivityUtc = DateTime.UtcNow;

    private void Watchdog()
    {
        AirPlayConnection? active;
        lock (_sessionLock)
        {
            active = _active;
        }

        if (active == null)
        {
            return;
        }

        var idle = DateTime.UtcNow - active.Rtsp.LastActivityUtc;
        if (idle > Options.ClientTimeout)
        {
            _log.Warn($"Client {active.Client} silent for {idle.TotalSeconds:F0} s; dropping the session.");
            EndSession(active, "client timed out");
            active.Rtsp.Close();
        }
    }

    // ---------------------------------------------------------------- stream events

    internal void AttachMirrorEvents(AirPlayConnection conn, MirrorStreamReceiver mirror)
    {
        mirror.CodecData += data => Raise(() => VideoCodecData?.Invoke(data));
        mirror.Frame += frame => Raise(() => VideoFrame?.Invoke(frame));
        mirror.Paused += () => Raise(() => VideoPaused?.Invoke());
        mirror.Resumed += () => Raise(() => VideoResumed?.Invoke());
        mirror.Error += message => Raise(() => StreamError?.Invoke(message));
        mirror.Closed += () =>
        {
            if (conn.Mirror == mirror)
            {
                Raise(() => VideoStopped?.Invoke());
            }
        };
    }

    internal void AttachAudioEvents(AirPlayConnection conn, AudioStreamReceiver audio)
    {
        Raise(() => AudioStarted?.Invoke(audio.Info));
        audio.Frame += frame => Raise(() => AudioFrame?.Invoke(frame));
        audio.Sync += sync => Raise(() => AudioSync?.Invoke(sync));
    }

    internal void OnMirrorStopped(AirPlayConnection conn) => Raise(() => VideoStopped?.Invoke());

    internal void OnVolume(AirPlayConnection conn, double db) => Raise(() => VolumeChanged?.Invoke(db));

    internal void OnProgress(AirPlayConnection conn, string progress) => _log.Debug($"progress: {progress}");

    internal void OnArtwork(AirPlayConnection conn, string contentType, byte[] data) => Raise(() => ArtworkReceived?.Invoke(contentType, data));

    internal void OnMetadata(AirPlayConnection conn, byte[] data) => Raise(() => MetadataReceived?.Invoke(data));

    /// <summary>Clock offset of the active client (client minus local, seconds), if timing sync is up.</summary>
    public double? ClientClockOffsetSeconds
    {
        get
        {
            lock (_sessionLock)
            {
                return _active?.Timing?.OffsetSeconds;
            }
        }
    }

    private void Raise(Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            _log.Error($"Event handler failed: {ex}");
        }
    }
}
