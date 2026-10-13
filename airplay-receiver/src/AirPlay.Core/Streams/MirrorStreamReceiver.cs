using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using AirPlay.Crypto;

namespace AirPlay.Streams;

public enum VideoCodec
{
    H264,
    H265,
}

/// <summary>Out-of-band parameter sets (SPS/PPS, plus VPS for HEVC) in Annex B form, with the advertised picture size.</summary>
public sealed class VideoCodecData
{
    public VideoCodecData(VideoCodec codec, byte[] parameterSets, int width, int height, int sourceWidth, int sourceHeight)
    {
        Codec = codec;
        ParameterSets = parameterSets;
        Width = width;
        Height = height;
        SourceWidth = sourceWidth;
        SourceHeight = sourceHeight;
    }

    public VideoCodec Codec { get; }
    public byte[] ParameterSets { get; }
    public int Width { get; }
    public int Height { get; }
    public int SourceWidth { get; }
    public int SourceHeight { get; }
}

/// <summary>One access unit in Annex B byte-stream form (start codes), ready for a decoder.</summary>
public sealed class VideoFrame
{
    public VideoFrame(byte[] data, int length, ulong ntpTimestamp, bool isKeyframe, bool includesParameterSets, VideoCodec codec)
    {
        Data = data;
        Length = length;
        NtpTimestamp = ntpTimestamp;
        IsKeyframe = isKeyframe;
        IncludesParameterSets = includesParameterSets;
        Codec = codec;
    }

    public byte[] Data { get; }
    public int Length { get; }

    /// <summary>Client-side capture time (NTP Q32.32, relative to the client's boot).</summary>
    public ulong NtpTimestamp { get; }
    public bool IsKeyframe { get; }
    public bool IncludesParameterSets { get; }
    public VideoCodec Codec { get; }

    public ReadOnlySpan<byte> Span => Data.AsSpan(0, Length);
}

/// <summary>
/// Receives the screen-mirroring video stream (SETUP stream type 110): a TCP connection
/// carrying 128-byte-headed packets whose video payloads are AES-128-CTR encrypted with a
/// continuous keystream, and whose NAL units are length-prefixed.
/// </summary>
public sealed class MirrorStreamReceiver : IDisposable
{
    private const int HeaderLength = 128;
    private const int MaxPayload = 16 * 1024 * 1024;
    private static readonly byte[] StartCode = { 0, 0, 0, 1 };

    private readonly Log _log;
    private readonly byte[] _key;
    private readonly byte[] _iv;
    private readonly int _preferredPort;
    private TcpListener? _listener;
    private Thread? _thread;
    private volatile bool _running;
    private Socket? _stream;

    public MirrorStreamReceiver(Log log, byte[] sharedStreamKey, ulong streamConnectionId, int preferredPort)
    {
        _log = log;
        (_key, _iv) = AirPlayKeys.VideoStreamKeys(sharedStreamKey, streamConnectionId);
        _preferredPort = preferredPort;
    }

    public int Port { get; private set; }

    public VideoCodec? Codec { get; private set; }

    public long FramesReceived { get; private set; }
    public long BytesReceived { get; private set; }

    public event Action<VideoCodecData>? CodecData;
    public event Action<VideoFrame>? Frame;
    public event Action? Paused;
    public event Action? Resumed;
    public event Action<string>? Error;
    public event Action? Closed;

    public void Start()
    {
        _listener = Rtsp.TcpListeners.Create(_preferredPort, 1, _log, "mirror data");
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _running = true;
        _thread = new Thread(Run) { IsBackground = true, Name = "airplay-mirror" };
        _thread.Start();
    }

    public void Stop()
    {
        _running = false;
        try
        {
            _listener?.Stop();
        }
        catch
        {
        }

        try
        {
            _stream?.Dispose();
        }
        catch
        {
        }
    }

    public void Dispose() => Stop();

    private void Run()
    {
        try
        {
            var listener = _listener!;
            listener.Server.ReceiveTimeout = 5000;
            Socket socket;
            try
            {
                socket = listener.AcceptSocket();
            }
            catch (Exception) when (!_running)
            {
                return;
            }

            _stream = socket;
            socket.NoDelay = true;
            socket.ReceiveTimeout = 5000;
            socket.ReceiveBufferSize = 1024 * 1024;
            _log.Info($"Mirror stream connected from {socket.RemoteEndPoint}");
            try
            {
                listener.Stop(); // one client only
            }
            catch
            {
            }

            ReadLoop(socket);
        }
        catch (Exception ex)
        {
            if (_running)
            {
                _log.Error($"Mirror stream failed: {ex.Message}");
                Error?.Invoke(ex.Message);
            }
        }
        finally
        {
            _running = false;
            Closed?.Invoke();
        }
    }

    private void ReadLoop(Socket socket)
    {
        using var ctr = new AesCtr(_key, _iv);
        var header = new byte[HeaderLength];
        var payload = new byte[256 * 1024];
        byte[]? pendingParameterSets = null;
        ulong pendingParameterSetsTimestamp = 0;
        var paused = false;

        while (_running)
        {
            if (!ReadExactly(socket, header, HeaderLength))
            {
                _log.Info("Mirror stream closed by client.");
                return;
            }

            var payloadSize = BinaryPrimitives.ReadInt32LittleEndian(header);
            if (payloadSize < 0 || payloadSize > MaxPayload)
            {
                throw new InvalidDataException($"Bad mirror payload size {payloadSize}.");
            }

            var payloadType = header[4];
            var payloadSubtype = header[5];
            var payloadOption = header[6];
            var ntp = BinaryPrimitives.ReadUInt64LittleEndian(header.AsSpan(8));
            if (payload.Length < payloadSize)
            {
                payload = new byte[Math.Max(payloadSize, payload.Length * 2)];
            }

            if (payloadSize > 0 && !ReadExactly(socket, payload, payloadSize))
            {
                _log.Info("Mirror stream closed by client mid-packet.");
                return;
            }

            BytesReceived += HeaderLength + payloadSize;

            switch (payloadType)
            {
                case 0x00:
                {
                    // Encrypted video: one or more length-prefixed NAL units.
                    var codec = Codec ?? VideoCodec.H264;
                    var prefix = pendingParameterSets;
                    var prefixLen = prefix?.Length ?? 0;
                    if (prefix != null && pendingParameterSetsTimestamp != ntp)
                    {
                        _log.Debug("Parameter-set packet timestamp differs from the following frame; prepending anyway.");
                    }

                    var frame = new byte[prefixLen + payloadSize];
                    if (prefix != null)
                    {
                        prefix.CopyTo(frame, 0);
                        pendingParameterSets = null;
                    }

                    ctr.Transform(payload.AsSpan(0, payloadSize), frame.AsSpan(prefixLen, payloadSize));
                    if (!ConvertLengthPrefixesToStartCodes(frame.AsSpan(prefixLen, payloadSize), codec, out var keyframe))
                    {
                        _log.Warn("Dropping a video packet whose NAL framing is invalid (bad key or corrupted stream).");
                        Error?.Invoke("invalid NAL framing");
                        break;
                    }

                    FramesReceived++;
                    // 0x10 in the subtype byte marks packets that carry an IDR frame.
                    keyframe |= (payloadSubtype & 0x10) != 0;
                    Frame?.Invoke(new VideoFrame(frame, frame.Length, ntp, keyframe, prefix != null, codec));
                    break;
                }

                case 0x01:
                {
                    // Unencrypted codec configuration (avcC or hvcC) plus picture dimensions in the header.
                    var sourceWidth = (int)BinaryPrimitives.ReadSingleLittleEndian(header.AsSpan(40));
                    var sourceHeight = (int)BinaryPrimitives.ReadSingleLittleEndian(header.AsSpan(44));
                    var width = (int)BinaryPrimitives.ReadSingleLittleEndian(header.AsSpan(56));
                    var height = (int)BinaryPrimitives.ReadSingleLittleEndian(header.AsSpan(60));

                    if (payloadOption is 0x56 or 0x5e)
                    {
                        if (!paused)
                        {
                            paused = true;
                            _log.Info("Client paused the video stream (screen off or app in background).");
                            Paused?.Invoke();
                        }
                    }
                    else if (paused && payloadOption is 0x16 or 0x1e)
                    {
                        paused = false;
                        _log.Info("Client resumed the video stream.");
                        Resumed?.Invoke();
                    }

                    if (payloadSize == 0)
                    {
                        _log.Error("Client sent an empty codec packet: it wants a codec we did not advertise (HEVC). Enable HEVC support or disable it on the device.");
                        Error?.Invoke("unsupported codec");
                        break;
                    }

                    byte[] parameterSets;
                    VideoCodec codec;
                    if (payloadSize >= 8 && payload[4] == (byte)'h' && payload[5] == (byte)'v' && payload[6] == (byte)'c' && payload[7] == (byte)'1')
                    {
                        codec = VideoCodec.H265;
                        parameterSets = ParseHvc(payload.AsSpan(0, payloadSize));
                    }
                    else
                    {
                        codec = VideoCodec.H264;
                        parameterSets = ParseAvcC(payload.AsSpan(0, payloadSize));
                    }

                    if (Codec != null && Codec != codec)
                    {
                        _log.Warn($"Video codec changed mid-session from {Codec} to {codec}.");
                    }

                    Codec = codec;
                    pendingParameterSets = parameterSets;
                    pendingParameterSetsTimestamp = ntp;
                    _log.Info($"Video codec data: {codec}, {width}x{height} (source {sourceWidth}x{sourceHeight}), {parameterSets.Length} bytes of parameter sets");
                    CodecData?.Invoke(new VideoCodecData(codec, parameterSets, width, height, sourceWidth, sourceHeight));
                    break;
                }

                case 0x02:
                    // Heartbeat (old protocol), no payload.
                    break;

                case 0x05:
                    // Streaming report (statistics), ignored.
                    break;

                default:
                    _log.Debug($"Ignoring mirror packet type 0x{payloadType:x2} ({payloadSize} bytes).");
                    break;
            }
        }
    }

    private static bool ReadExactly(Socket socket, byte[] buffer, int count)
    {
        var offset = 0;
        while (offset < count)
        {
            int n;
            try
            {
                n = socket.Receive(buffer, offset, count - offset, SocketFlags.None);
            }
            catch (SocketException ex) when (ex.SocketErrorCode is SocketError.TimedOut or SocketError.WouldBlock)
            {
                continue;
            }

            if (n <= 0)
            {
                return false;
            }

            offset += n;
        }

        return true;
    }

    /// <summary>Rewrites the 4-byte big-endian NAL length prefixes into Annex B start codes, in place.</summary>
    internal static bool ConvertLengthPrefixesToStartCodes(Span<byte> data, VideoCodec codec, out bool sawKeyframe)
    {
        sawKeyframe = false;
        var pos = 0;
        while (pos < data.Length)
        {
            if (pos + 4 > data.Length)
            {
                return false;
            }

            var len = BinaryPrimitives.ReadInt32BigEndian(data[pos..]);
            if (len <= 0 || len > data.Length - pos - 4)
            {
                return false;
            }

            StartCode.CopyTo(data[pos..]);
            pos += 4;
            var nalHeader = data[pos];
            if ((nalHeader & 0x80) != 0)
            {
                return false; // forbidden_zero_bit
            }

            if (codec == VideoCodec.H264)
            {
                var type = nalHeader & 0x1f;
                if (type == 5)
                {
                    sawKeyframe = true;
                }
            }
            else
            {
                var type = (nalHeader >> 1) & 0x3f;
                if (type is >= 16 and <= 21)
                {
                    sawKeyframe = true;
                }
            }

            pos += len;
        }

        return pos == data.Length;
    }

    /// <summary>Extracts SPS and PPS from an avcC record into Annex B form.</summary>
    internal static byte[] ParseAvcC(ReadOnlySpan<byte> avcc)
    {
        if (avcc.Length < 8)
        {
            throw new InvalidDataException("avcC record too short.");
        }

        var spsSize = BinaryPrimitives.ReadUInt16BigEndian(avcc[6..]);
        if (8 + spsSize + 3 > avcc.Length)
        {
            throw new InvalidDataException("avcC SPS size out of range.");
        }

        var sps = avcc.Slice(8, spsSize);
        var ppsCount = avcc[8 + spsSize];
        var ppsSize = BinaryPrimitives.ReadUInt16BigEndian(avcc[(9 + spsSize)..]);
        if (11 + spsSize + ppsSize > avcc.Length || ppsCount == 0)
        {
            throw new InvalidDataException("avcC PPS size out of range.");
        }

        var pps = avcc.Slice(11 + spsSize, ppsSize);
        var result = new byte[4 + spsSize + 4 + ppsSize];
        StartCode.CopyTo(result, 0);
        sps.CopyTo(result.AsSpan(4));
        StartCode.CopyTo(result, 4 + spsSize);
        pps.CopyTo(result.AsSpan(8 + spsSize));
        return result;
    }

    /// <summary>Extracts VPS, SPS and PPS from the HEVC codec packet layout iOS sends (hvcC at offset 0x75).</summary>
    internal static byte[] ParseHvc(ReadOnlySpan<byte> payload)
    {
        const int Base = 0x75;
        var ms = new MemoryStream();
        var pos = Base;
        foreach (var marker in new byte[] { 0xa0, 0xa1, 0xa2 })
        {
            if (pos + 5 > payload.Length || payload[pos] != marker || payload[pos + 1] != 0x00 || payload[pos + 2] != 0x01)
            {
                throw new InvalidDataException("Unexpected HEVC parameter-set layout.");
            }

            var size = BinaryPrimitives.ReadUInt16BigEndian(payload[(pos + 3)..]);
            pos += 5;
            if (pos + size > payload.Length)
            {
                throw new InvalidDataException("HEVC parameter set out of range.");
            }

            ms.Write(StartCode);
            ms.Write(payload.Slice(pos, size));
            pos += size;
        }

        return ms.ToArray();
    }
}
