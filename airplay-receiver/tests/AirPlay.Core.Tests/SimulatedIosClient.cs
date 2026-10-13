using System.Net;
using System.Net.Sockets;
using System.Text;
using AirPlay.Crypto;
using AirPlay.Plist;
using AirPlay.Rtsp;

namespace AirPlay.Tests;

/// <summary>Drives the receiver the way an iPhone does when Screen Mirroring starts (over loopback).</summary>
internal sealed class SimulatedIosClient : IDisposable
{
    private readonly TcpClient _tcp = new();
    private NetworkStream? _stream;
    private readonly byte[] _buffer = new byte[256 * 1024];
    private int _filled;
    private int _cseq;

    public PairingTests.SimulatedClient Pairing { get; } = new();
    public byte[] FairPlayKey { get; } = Enumerable.Range(0, 16).Select(i => (byte)(0xA0 + i)).ToArray();
    public byte[] Eiv { get; } = Enumerable.Range(0, 16).Select(i => (byte)(0x30 + i)).ToArray();
    public byte[]? ReceiverEdPublic { get; private set; }
    public byte[]? SharedStreamKey { get; private set; }
    public int MirrorDataPort { get; private set; }
    public int AudioDataPort { get; private set; }
    public int AudioControlPort { get; private set; }
    public int TimingPort { get; private set; }

    public async Task ConnectAsync(int port)
    {
        await _tcp.ConnectAsync(IPAddress.Loopback, port);
        _stream = _tcp.GetStream();
    }

    public async Task<(int Status, Dictionary<string, string> Headers, byte[] Body)> RequestAsync(string method, string uri, byte[]? body = null, string? contentType = null, params (string, string)[] headers)
    {
        var sb = new StringBuilder();
        sb.Append(method).Append(' ').Append(uri).Append(" RTSP/1.0\r\n");
        sb.Append("CSeq: ").Append(++_cseq).Append("\r\n");
        sb.Append("User-Agent: AirPlay/670.6.2\r\n");
        foreach (var (k, v) in headers)
        {
            sb.Append(k).Append(": ").Append(v).Append("\r\n");
        }

        if (contentType != null)
        {
            sb.Append("Content-Type: ").Append(contentType).Append("\r\n");
        }

        if (body != null && body.Length > 0)
        {
            sb.Append("Content-Length: ").Append(body.Length).Append("\r\n");
        }

        sb.Append("\r\n");
        var head = Encoding.ASCII.GetBytes(sb.ToString());
        await _stream!.WriteAsync(head);
        if (body != null && body.Length > 0)
        {
            await _stream.WriteAsync(body);
        }

        return await ReadResponseAsync();
    }

    private async Task<(int, Dictionary<string, string>, byte[])> ReadResponseAsync()
    {
        while (true)
        {
            var end = _buffer.AsSpan(0, _filled).IndexOf("\r\n\r\n"u8);
            if (end >= 0)
            {
                var headText = Encoding.ASCII.GetString(_buffer, 0, end);
                var lines = headText.Split("\r\n");
                var status = int.Parse(lines[0].Split(' ')[1]);
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var line in lines.Skip(1))
                {
                    var c = line.IndexOf(':');
                    headers[line[..c].Trim()] = line[(c + 1)..].Trim();
                }

                var len = headers.TryGetValue("Content-Length", out var cl) ? int.Parse(cl) : 0;
                if (_filled >= end + 4 + len)
                {
                    var body = _buffer.AsSpan(end + 4, len).ToArray();
                    var consumed = end + 4 + len;
                    Buffer.BlockCopy(_buffer, consumed, _buffer, 0, _filled - consumed);
                    _filled -= consumed;
                    return (status, headers, body);
                }
            }

            var n = await _stream!.ReadAsync(_buffer.AsMemory(_filled)).AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            if (n <= 0)
            {
                throw new IOException("connection closed");
            }

            _filled += n;
        }
    }

    public async Task<PlistDict> GetInfoAsync()
    {
        var q = BinaryPlist.Write(new PlistDict { ["qualifier"] = new List<object?> { "txtAirPlay" } });
        var (status, _, body) = await RequestAsync("GET", "/info", q, "application/x-apple-binary-plist");
        if (status != 200)
        {
            throw new InvalidOperationException($"GET /info -> {status}");
        }

        return BinaryPlist.ParseDict(body);
    }

    public async Task PairAsync()
    {
        var (s1, _, pk) = await RequestAsync("POST", "/pair-setup", Pairing.EdPublic, "application/octet-stream");
        if (s1 != 200 || pk.Length != 32)
        {
            throw new InvalidOperationException($"pair-setup -> {s1}");
        }

        ReceiverEdPublic = pk;
        var (s2, _, step1) = await RequestAsync("POST", "/pair-verify", Pairing.Step1Request(), "application/octet-stream");
        if (s2 != 200)
        {
            throw new InvalidOperationException($"pair-verify 1 -> {s2}");
        }

        var (s3, _, _) = await RequestAsync("POST", "/pair-verify", Pairing.Step2Request(step1, pk), "application/octet-stream");
        if (s3 != 200)
        {
            throw new InvalidOperationException($"pair-verify 2 -> {s3}");
        }
    }

    public async Task FairPlayAsync()
    {
        var req1 = new byte[16];
        "FPLY"u8.CopyTo(req1);
        req1[4] = 3;
        req1[5] = 1;
        req1[6] = 1;
        req1[11] = 4;
        req1[14] = 2;
        var (s1, _, r1) = await RequestAsync("POST", "/fp-setup", req1, "application/octet-stream");
        if (s1 != 200 || r1.Length != 142)
        {
            throw new InvalidOperationException($"fp-setup 1 -> {s1}/{r1.Length}");
        }

        var req2 = new byte[164];
        "FPLY"u8.CopyTo(req2);
        req2[4] = 3;
        req2[5] = 1;
        req2[6] = 3;
        var (s2, _, r2) = await RequestAsync("POST", "/fp-setup", req2, "application/octet-stream");
        if (s2 != 200 || r2.Length != 32)
        {
            throw new InvalidOperationException($"fp-setup 2 -> {s2}/{r2.Length}");
        }
    }

    public PlistDict SetupPhase1Plist(int timingPort = 0) => new()
    {
        ["ekey"] = new byte[72],
        ["eiv"] = Eiv,
        ["et"] = 32L,
        ["isScreenMirroringSession"] = true,
        ["name"] = "Mark's iPhone",
        ["model"] = "iPhone15,2",
        ["deviceID"] = "11:22:33:44:55:66",
        ["macAddress"] = "11:22:33:44:55:66",
        ["osName"] = "iPhone OS",
        ["osVersion"] = "18.0",
        ["sourceVersion"] = "670.6.2",
        ["sessionUUID"] = Guid.NewGuid().ToString().ToUpperInvariant(),
        ["timingProtocol"] = timingPort > 0 ? "NTP" : "None",
        ["timingPort"] = (long)timingPort,
    };

    public async Task<(int Status, Dictionary<string, string> Headers, PlistDict? Body)> SetupPhase1Async(int timingPort = 0, string? authorization = null)
    {
        var headers = authorization == null ? Array.Empty<(string, string)>() : new[] { ("Authorization", authorization) };
        var (status, h, body) = await RequestAsync("SETUP", "rtsp://127.0.0.1/1234567890", BinaryPlist.Write(SetupPhase1Plist(timingPort)), "application/x-apple-binary-plist", headers);
        if (status == 200)
        {
            SharedStreamKey = AirPlayKeys.SharedStreamKey(FairPlayKey, Pairing.Secret);
            var dict = BinaryPlist.ParseDict(body);
            TimingPort = (int)(dict.GetInt("timingPort") ?? 0);
            return (status, h, dict);
        }

        return (status, h, null);
    }

    public async Task SetupMirrorAsync(long streamConnectionId)
    {
        var req = new PlistDict
        {
            ["streams"] = new List<object?>
            {
                new PlistDict { ["type"] = 110L, ["streamConnectionID"] = streamConnectionId, ["latencyMs"] = 90L, ["timestampInfo"] = new List<object?>() },
            },
        };
        var (status, _, body) = await RequestAsync("SETUP", "rtsp://127.0.0.1/1234567890", BinaryPlist.Write(req), "application/x-apple-binary-plist");
        if (status != 200)
        {
            throw new InvalidOperationException($"SETUP mirror -> {status}");
        }

        var stream = (PlistDict)BinaryPlist.ParseDict(body).GetArray("streams")![0]!;
        MirrorDataPort = (int)stream.GetInt("dataPort")!.Value;
    }

    public async Task SetupAudioAsync(int clientControlPort)
    {
        var req = new PlistDict
        {
            ["streams"] = new List<object?>
            {
                new PlistDict { ["type"] = 96L, ["ct"] = 8L, ["spf"] = 480L, ["audioFormat"] = 0x1000000L, ["controlPort"] = (long)clientControlPort, ["isMedia"] = false, ["usingScreen"] = true },
            },
        };
        var (status, _, body) = await RequestAsync("SETUP", "rtsp://127.0.0.1/1234567890", BinaryPlist.Write(req), "application/x-apple-binary-plist");
        if (status != 200)
        {
            throw new InvalidOperationException($"SETUP audio -> {status}");
        }

        var stream = (PlistDict)BinaryPlist.ParseDict(body).GetArray("streams")![0]!;
        AudioDataPort = (int)stream.GetInt("dataPort")!.Value;
        AudioControlPort = (int)stream.GetInt("controlPort")!.Value;
    }

    public void Dispose() => _tcp.Dispose();
}

/// <summary>Stands in for the native playfair library: returns a fixed key the test client knows.</summary>
internal sealed class FixedKeyFairPlay : FairPlay.IFairPlayDecryptor
{
    private readonly byte[] _key;

    public FixedKeyFairPlay(byte[] key)
    {
        _key = key;
    }

    public byte[] DecryptKey(ReadOnlySpan<byte> fpSetupMessage, ReadOnlySpan<byte> encryptedKey) => _key.ToArray();
}
