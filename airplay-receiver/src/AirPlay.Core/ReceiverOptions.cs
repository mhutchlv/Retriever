using AirPlay.FairPlay;
using AirPlay.Pairing;

namespace AirPlay;

/// <summary>Everything that can be configured on the receiver. Change before calling <see cref="AirPlayReceiver.Start"/>.</summary>
public sealed class ReceiverOptions
{
    /// <summary>The name shown in the iPhone's Screen Mirroring list.</summary>
    public string Name { get; set; } = Environment.MachineName;

    /// <summary>Optional AirPlay password. iOS prompts for it when the session starts.</summary>
    public string? Password { get; set; }

    public int RtspPort { get; set; } = 7000;
    public int MirrorDataPort { get; set; } = 7100;
    public int AudioDataPort { get; set; } = 6000;
    public int AudioControlPort { get; set; } = 6001;
    public int TimingPort { get; set; } = 7011;

    /// <summary>Six-byte hardware address used as the device id. Derived from the first physical NIC when null.</summary>
    public byte[]? MacAddress { get; set; }

    /// <summary>Long-lived Ed25519 identity. When null, <see cref="IdentityFile"/> is used, else a deterministic key from the MAC.</summary>
    public ReceiverIdentity? Identity { get; set; }

    public string? IdentityFile { get; set; }

    public int DisplayWidth { get; set; } = 1920;
    public int DisplayHeight { get; set; } = 1080;
    public int RefreshRate { get; set; } = 60;
    public int MaxFps { get; set; } = 60;
    public bool Overscanned { get; set; }

    /// <summary>Advertise HEVC (feature bit 42). Needs an HEVC decoder on the receiver side.</summary>
    public bool SupportHevc { get; set; }

    /// <summary>Advertise over multicast DNS. Turn off for tests or when another responder advertises on our behalf.</summary>
    public bool AdvertiseOverMdns { get; set; } = true;

    /// <summary>When a second device starts a session, drop the current one instead of refusing with 409.</summary>
    public bool AllowTakeover { get; set; } = true;

    /// <summary>Session is dropped when the client stops sending anything (feedback is every 2 s) for this long.</summary>
    public TimeSpan ClientTimeout { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>Audio latency announced in RECORD, in microseconds.</summary>
    public int AudioLatencyMicros { get; set; } = 250_000;

    public IFairPlayDecryptor? FairPlayDecryptor { get; set; }

    public string Model { get; set; } = "AppleTV3,2";
    public string SourceVersion { get; set; } = "220.68";
    public string PairingIdentifier { get; set; } = "2e388006-13ba-4041-9a67-25dd4a43d536";

    /// <summary>Low 32 feature bits. Bit 27 (legacy pairing) must stay on for the pair-setup/verify flow.</summary>
    public uint Features1 { get; set; } = 0x5A7FFEE6;
    public uint Features2 { get; set; } = 0x0;

    public ulong Features => ((ulong)(Features2 | (SupportHevc ? 1u << 10 : 0u)) << 32) | Features1;

    public string FeaturesText => $"0x{Features1:X},0x{(Features2 | (SupportHevc ? 1u << 10 : 0u)):X}";
}

/// <summary>What we know about the connected iOS device, from SETUP.</summary>
public sealed class ClientInfo
{
    public string? Name { get; init; }
    public string? Model { get; init; }
    public string? DeviceId { get; init; }
    public string? OsName { get; init; }
    public string? OsVersion { get; init; }
    public string? SourceVersion { get; init; }
    public System.Net.IPAddress? Address { get; init; }
    public string? UserAgent { get; init; }

    public override string ToString() => $"{Name ?? "unknown"} ({Model ?? "?"}, {OsName ?? "iOS"} {OsVersion ?? "?"}) at {Address}";
}
