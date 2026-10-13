using AirPlay.FairPlay;
using AirPlay.Pairing;
using AirPlay.Rtsp;
using AirPlay.Streams;

namespace AirPlay.Session;

/// <summary>Per-control-connection state: pairing, FairPlay, keys and any running streams.</summary>
internal sealed class AirPlayConnection : IDisposable
{
    public AirPlayConnection(RtspConnection rtsp, ReceiverIdentity identity, IFairPlayDecryptor fairPlayDecryptor)
    {
        Rtsp = rtsp;
        Pairing = new PairingSession(identity);
        FairPlay = new FairPlaySession(fairPlayDecryptor);
    }

    public RtspConnection Rtsp { get; }
    public PairingSession Pairing { get; }
    public FairPlaySession FairPlay { get; }

    public bool Authenticated { get; set; }
    public string? Nonce { get; set; }
    public int AuthFailures { get; set; }

    /// <summary>Set once the first SETUP (with ekey/eiv) succeeded: this connection owns the media session.</summary>
    public bool HasSession { get; set; }

    public byte[]? SharedStreamKey { get; set; }
    public byte[]? AudioIv { get; set; }
    public ClientInfo? Client { get; set; }

    public MirrorStreamReceiver? Mirror { get; set; }
    public AudioStreamReceiver? Audio { get; set; }
    public NtpTimingClient? Timing { get; set; }

    public double VolumeDb { get; set; }

    public void StopMirror()
    {
        var m = Mirror;
        Mirror = null;
        m?.Dispose();
    }

    public void StopAudio()
    {
        var a = Audio;
        Audio = null;
        a?.Dispose();
    }

    public void StopTiming()
    {
        var t = Timing;
        Timing = null;
        t?.Dispose();
    }

    public void TearDown()
    {
        StopMirror();
        StopAudio();
        StopTiming();
        HasSession = false;
    }

    public void Dispose() => TearDown();
}
