using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using AirPlay.Crypto;

namespace AirPlay.Streams;

/// <summary>Compression type ("ct") values from the SETUP stream description.</summary>
public enum AudioCodec
{
    Pcm = 1,
    Alac = 2,
    AacLc = 4,
    AacEld = 8,
}

public sealed class AudioStreamInfo
{
    public AudioStreamInfo(AudioCodec codec, int samplesPerFrame, int sampleRate, int channels, ulong audioFormat)
    {
        Codec = codec;
        SamplesPerFrame = samplesPerFrame;
        SampleRate = sampleRate;
        Channels = channels;
        AudioFormat = audioFormat;
    }

    public AudioCodec Codec { get; }
    public int SamplesPerFrame { get; }
    public int SampleRate { get; }
    public int Channels { get; }

    /// <summary>The raw "audioFormat" bit from SETUP (e.g. 0x1000000 = AAC-ELD 44100/2).</summary>
    public ulong AudioFormat { get; }
}

public sealed class AudioFrame
{
    public AudioFrame(byte[] data, uint rtpTimestamp, ushort sequenceNumber)
    {
        Data = data;
        RtpTimestamp = rtpTimestamp;
        SequenceNumber = sequenceNumber;
    }

    /// <summary>One decrypted codec frame (AAC-ELD or ALAC payload).</summary>
    public byte[] Data { get; }
    public uint RtpTimestamp { get; }
    public ushort SequenceNumber { get; }
}

/// <summary>A sync packet from the client: RTP timestamp &lt;-&gt; client NTP time.</summary>
public readonly record struct AudioSync(uint RtpTimestamp, ulong NtpTimestamp, uint NextRtpTimestamp);

/// <summary>
/// Receives the RAOP audio stream (SETUP stream type 96): RTP over UDP with AES-128-CBC
/// payloads, a control port for sync and retransmission, and a small reorder buffer.
/// </summary>
public sealed class AudioStreamReceiver : IDisposable
{
    private const int MaxPacket = 2048;
    private static readonly byte[] NoDataMarker = { 0x00, 0x68, 0x34, 0x00 };

    private readonly Log _log;
    private readonly AesCbc _cipher;
    private readonly IPAddress _client;
    private readonly int _clientControlPort;
    private readonly int _preferredDataPort;
    private readonly int _preferredControlPort;
    private readonly JitterBuffer _buffer;
    private Socket? _data;
    private Socket? _control;
    private Thread? _dataThread;
    private Thread? _controlThread;
    private volatile bool _running;
    private ushort _controlSeq;
    private readonly object _sendLock = new();

    public AudioStreamReceiver(Log log, byte[] key, byte[] iv, IPAddress clientAddress, int clientControlPort, AudioStreamInfo info, int preferredDataPort, int preferredControlPort)
    {
        _log = log;
        _cipher = new AesCbc(key, iv);
        _client = clientAddress;
        _clientControlPort = clientControlPort;
        _preferredDataPort = preferredDataPort;
        _preferredControlPort = preferredControlPort;
        Info = info;
        _buffer = new JitterBuffer(f => Frame?.Invoke(f), RequestResend);
    }

    public AudioStreamInfo Info { get; }
    public int DataPort { get; private set; }
    public int ControlPort { get; private set; }
    public AudioSync? LastSync { get; private set; }
    public long PacketsReceived { get; private set; }

    public event Action<AudioFrame>? Frame;
    public event Action<AudioSync>? Sync;

    public void Start()
    {
        _data = UdpPorts.Bind(_client.AddressFamily, _preferredDataPort, _log, "audio data");
        _control = UdpPorts.Bind(_client.AddressFamily, _preferredControlPort, _log, "audio control");
        DataPort = ((IPEndPoint)_data.LocalEndPoint!).Port;
        ControlPort = ((IPEndPoint)_control.LocalEndPoint!).Port;
        _data.ReceiveTimeout = 1000;
        _control.ReceiveTimeout = 1000;
        _data.ReceiveBufferSize = 512 * 1024;
        _running = true;
        _dataThread = new Thread(DataLoop) { IsBackground = true, Name = "airplay-audio-data" };
        _controlThread = new Thread(ControlLoop) { IsBackground = true, Name = "airplay-audio-control" };
        _dataThread.Start();
        _controlThread.Start();
        _log.Info($"Audio stream ({Info.Codec}, spf {Info.SamplesPerFrame}) on UDP data {DataPort}, control {ControlPort}");
    }

    public void Stop()
    {
        _running = false;
        _data?.Dispose();
        _control?.Dispose();
        _data = null;
        _control = null;
    }

    public void Dispose()
    {
        Stop();
        _cipher.Dispose();
    }

    private void DataLoop()
    {
        var packet = new byte[MaxPacket];
        EndPoint any = new IPEndPoint(_client.AddressFamily == AddressFamily.InterNetwork ? IPAddress.Any : IPAddress.IPv6Any, 0);
        while (_running)
        {
            var socket = _data;
            if (socket == null)
            {
                return;
            }

            int n;
            try
            {
                n = socket.ReceiveFrom(packet, ref any);
            }
            catch (SocketException ex) when (ex.SocketErrorCode is SocketError.TimedOut or SocketError.WouldBlock)
            {
                _buffer.Tick();
                continue;
            }
            catch (Exception)
            {
                return;
            }

            PacketsReceived++;
            HandleDataPacket(packet.AsSpan(0, n));
        }
    }

    private void ControlLoop()
    {
        var packet = new byte[MaxPacket];
        EndPoint any = new IPEndPoint(_client.AddressFamily == AddressFamily.InterNetwork ? IPAddress.Any : IPAddress.IPv6Any, 0);
        while (_running)
        {
            var socket = _control;
            if (socket == null)
            {
                return;
            }

            int n;
            try
            {
                n = socket.ReceiveFrom(packet, ref any);
            }
            catch (SocketException ex) when (ex.SocketErrorCode is SocketError.TimedOut or SocketError.WouldBlock)
            {
                continue;
            }
            catch (Exception)
            {
                return;
            }

            if (n < 8)
            {
                continue;
            }

            var type = packet[1] & 0x7f;
            if (type == 0x56)
            {
                // Retransmitted data packet, wrapped with a 4-byte header.
                HandleDataPacket(packet.AsSpan(4, n - 4));
            }
            else if (type == 0x54 && n >= 20)
            {
                var sync = new AudioSync(
                    BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(4)),
                    BinaryPrimitives.ReadUInt64BigEndian(packet.AsSpan(8)),
                    BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(16)));
                LastSync = sync;
                Sync?.Invoke(sync);
            }
        }
    }

    private void HandleDataPacket(ReadOnlySpan<byte> packet)
    {
        if (packet.Length < 12)
        {
            return;
        }

        if (packet.Length == 12)
        {
            return; // keep-alive without payload
        }

        if (Info.Codec == AudioCodec.Alac && packet.Length == 44)
        {
            return; // ALAC "format only" packets sent before real audio starts
        }

        var seq = BinaryPrimitives.ReadUInt16BigEndian(packet[2..]);
        var ts = BinaryPrimitives.ReadUInt32BigEndian(packet[4..]);
        var payload = packet[12..];
        var decrypted = new byte[payload.Length];
        if (payload.Length == 4 && payload.SequenceEqual(NoDataMarker))
        {
            return;
        }

        _cipher.DecryptPacket(payload, decrypted);
        _buffer.Enqueue(new AudioFrame(decrypted, ts, seq));
    }

    private void RequestResend(ushort firstSeq, ushort count)
    {
        var socket = _control;
        if (socket == null || _clientControlPort == 0)
        {
            return;
        }

        var request = new byte[8];
        request[0] = 0x80;
        request[1] = 0x55 | 0x80;
        ushort ours;
        lock (_sendLock)
        {
            ours = _controlSeq++;
        }

        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(2), ours);
        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(4), firstSeq);
        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(6), count);
        try
        {
            socket.SendTo(request, new IPEndPoint(_client, _clientControlPort));
        }
        catch (Exception ex)
        {
            _log.Debug($"audio: resend request failed: {ex.Message}");
        }
    }

    /// <summary>Reorders packets by RTP sequence number, drops duplicates, asks for retransmits and gives up on holes after a short wait.</summary>
    internal sealed class JitterBuffer
    {
        private const int MaxPending = 64;
        private static readonly TimeSpan MaxWait = TimeSpan.FromMilliseconds(120);

        private readonly Action<AudioFrame> _emit;
        private readonly Action<ushort, ushort> _resend;
        private readonly Dictionary<ushort, AudioFrame> _pending = new();
        private readonly object _lock = new();
        private bool _started;
        private ushort _next;
        private DateTime _gapSince;
        private bool _resendRequested;

        public JitterBuffer(Action<AudioFrame> emit, Action<ushort, ushort> resend)
        {
            _emit = emit;
            _resend = resend;
        }

        public void Enqueue(AudioFrame frame)
        {
            List<AudioFrame>? ready = null;
            lock (_lock)
            {
                if (!_started)
                {
                    _started = true;
                    _next = frame.SequenceNumber;
                }

                var diff = (short)(frame.SequenceNumber - _next);
                if (diff < 0)
                {
                    return; // duplicate or late
                }

                if (diff == 0)
                {
                    ready = new List<AudioFrame> { frame };
                    _next++;
                    _resendRequested = false;
                    DrainReady(ready);
                }
                else
                {
                    if (_pending.TryAdd(frame.SequenceNumber, frame) && _pending.Count == 1)
                    {
                        _gapSince = DateTime.UtcNow;
                    }

                    if (!_resendRequested)
                    {
                        _resendRequested = true;
                        _resend(_next, (ushort)diff);
                    }

                    if (_pending.Count > MaxPending || DateTime.UtcNow - _gapSince > MaxWait)
                    {
                        ready = new List<AudioFrame>();
                        SkipGap(ready);
                    }
                }
            }

            if (ready != null)
            {
                foreach (var f in ready)
                {
                    _emit(f);
                }
            }
        }

        /// <summary>Called periodically so a hole does not stall the stream when no further packets arrive.</summary>
        public void Tick()
        {
            List<AudioFrame>? ready = null;
            lock (_lock)
            {
                if (_pending.Count > 0 && DateTime.UtcNow - _gapSince > MaxWait)
                {
                    ready = new List<AudioFrame>();
                    SkipGap(ready);
                }
            }

            if (ready != null)
            {
                foreach (var f in ready)
                {
                    _emit(f);
                }
            }
        }

        private void SkipGap(List<AudioFrame> ready)
        {
            // Jump to the oldest pending packet (in sequence order) and drain from there.
            ushort oldest = 0;
            var first = true;
            foreach (var seq in _pending.Keys)
            {
                if (first || (short)(seq - oldest) < 0)
                {
                    oldest = seq;
                    first = false;
                }
            }

            _next = oldest;
            _resendRequested = false;
            DrainReady(ready);
        }

        private void DrainReady(List<AudioFrame> ready)
        {
            while (_pending.Remove(_next, out var f))
            {
                ready.Add(f);
                _next++;
            }

            if (_pending.Count > 0)
            {
                _gapSince = DateTime.UtcNow;
            }
        }
    }
}
