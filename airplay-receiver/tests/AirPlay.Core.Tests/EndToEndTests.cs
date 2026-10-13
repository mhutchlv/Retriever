using System.Net;
using System.Net.Sockets;
using AirPlay.Crypto;
using AirPlay.Pairing;
using AirPlay.Plist;
using AirPlay.Streams;
using Xunit;

namespace AirPlay.Tests;

public class EndToEndTests
{
    private static AirPlayReceiver NewReceiver(SimulatedIosClient client, string? password = null) => new(new ReceiverOptions
    {
        Name = "Test Receiver",
        RtspPort = 0,
        MirrorDataPort = 0,
        AudioDataPort = 0,
        AudioControlPort = 0,
        TimingPort = 0,
        AdvertiseOverMdns = false,
        Password = password,
        MacAddress = new byte[] { 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff },
        Identity = ReceiverIdentity.Generate(),
        FairPlayDecryptor = new FixedKeyFairPlay(client.FairPlayKey),
    });

    [Fact]
    public async Task FullMirroringSessionOverLoopback()
    {
        using var client = new SimulatedIosClient();
        using var receiver = NewReceiver(client);
        var connected = new TaskCompletionSource<ClientInfo>();
        var disconnected = new TaskCompletionSource<string>();
        var codec = new TaskCompletionSource<VideoCodecData>();
        var frame = new TaskCompletionSource<VideoFrame>();
        var audioStarted = new TaskCompletionSource<AudioStreamInfo>();
        var audioFrame = new TaskCompletionSource<AudioFrame>();
        var volume = new TaskCompletionSource<double>();
        receiver.ClientConnected += c => connected.TrySetResult(c);
        receiver.ClientDisconnected += (_, reason) => disconnected.TrySetResult(reason);
        receiver.VideoCodecData += d => codec.TrySetResult(d);
        receiver.VideoFrame += f => frame.TrySetResult(f);
        receiver.AudioStarted += i => audioStarted.TrySetResult(i);
        receiver.AudioFrame += f => audioFrame.TrySetResult(f);
        receiver.VolumeChanged += v => volume.TrySetResult(v);
        receiver.Start();
        Assert.NotEqual(0, receiver.RtspPort);

        await client.ConnectAsync(receiver.RtspPort);

        // Discovery handshake: the first GET /info only asks for the TXT record.
        var info = await client.GetInfoAsync();
        Assert.NotNull(info.GetData("txtAirPlay"));
        var (status, _, fullInfo) = await client.RequestAsync("GET", "/info");
        Assert.Equal(200, status);
        var full = BinaryPlist.ParseDict(fullInfo);
        Assert.Equal("Test Receiver", full.GetString("name"));
        Assert.Equal("aa:bb:cc:dd:ee:ff", full.GetString("deviceID"));
        Assert.Equal(receiver.Identity.PublicKey, full.GetData("pk"));
        Assert.Equal(0x5A7FFEE6L, full.GetInt("features"));
        Assert.NotNull(full.GetArray("displays"));

        await client.PairAsync();
        Assert.Equal(receiver.Identity.PublicKey, client.ReceiverEdPublic);
        await client.FairPlayAsync();

        // Timing: pretend to be the client's NTP timing port and answer one request.
        using var timing = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        var timingPort = ((IPEndPoint)timing.Client.LocalEndPoint!).Port;
        var ntpAnswered = Task.Run(async () =>
        {
            var r = await timing.ReceiveAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(32, r.Buffer.Length);
            Assert.Equal(0x80, r.Buffer[0]);
            Assert.Equal(0xd2, r.Buffer[1]);
            var reply = new byte[32];
            reply[0] = 0x80;
            reply[1] = 0xd3;
            Array.Copy(r.Buffer, 24, reply, 8, 8); // echo t1
            var now = Ntp.LocalNow();
            System.Buffers.Binary.BinaryPrimitives.WriteUInt64BigEndian(reply.AsSpan(16), now);
            System.Buffers.Binary.BinaryPrimitives.WriteUInt64BigEndian(reply.AsSpan(24), now);
            await timing.SendAsync(reply, reply.Length, r.RemoteEndPoint);
        });

        var (setupStatus, _, setupBody) = await client.SetupPhase1Async(timingPort);
        Assert.Equal(200, setupStatus);
        Assert.Equal(0L, setupBody!.GetInt("eventPort"));
        Assert.True(setupBody.GetInt("timingPort") > 0);
        var who = await connected.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("Mark's iPhone", who.Name);
        Assert.Equal("iPhone15,2", who.Model);
        Assert.Equal(who, receiver.ActiveClient);
        await ntpAnswered.WaitAsync(TimeSpan.FromSeconds(5));

        const long streamId = -4903871290523402176L;
        await client.SetupMirrorAsync(streamId);
        Assert.NotEqual(0, client.MirrorDataPort);

        // Audio stream setup with our own control port so resend requests have somewhere to go.
        using var control = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        await client.SetupAudioAsync(((IPEndPoint)control.Client.LocalEndPoint!).Port);
        Assert.NotEqual(0, client.AudioDataPort);
        var audioInfo = await audioStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(AudioCodec.AacEld, audioInfo.Codec);
        Assert.Equal(480, audioInfo.SamplesPerFrame);

        var (recordStatus, recordHeaders, _) = await client.RequestAsync("RECORD", "rtsp://127.0.0.1/1234567890");
        Assert.Equal(200, recordStatus);
        Assert.Equal("11025", recordHeaders["Audio-Latency"]);

        var (volStatus, _, _) = await client.RequestAsync("SET_PARAMETER", "rtsp://127.0.0.1/1234567890", "volume: -7.5\r\n"u8.ToArray(), "text/parameters");
        Assert.Equal(200, volStatus);
        Assert.Equal(-7.5, await volume.Task.WaitAsync(TimeSpan.FromSeconds(5)));
        var (getStatus, _, getBody) = await client.RequestAsync("GET_PARAMETER", "rtsp://127.0.0.1/1234567890", "volume\r\n"u8.ToArray(), "text/parameters");
        Assert.Equal(200, getStatus);
        Assert.Equal("volume: -7.500000\r\n", System.Text.Encoding.ASCII.GetString(getBody));

        // Video: the client's keys must match what the receiver derived.
        using var video = new TcpClient();
        await video.ConnectAsync(IPAddress.Loopback, client.MirrorDataPort);
        var vs = video.GetStream();
        var avcc = MirrorStreamTests.BuildAvcC();
        await vs.WriteAsync(MirrorStreamTests.Header(avcc.Length, 1, 0, 0x16, 500, 1170, 2532));
        await vs.WriteAsync(avcc);
        var (vkey, viv) = AirPlayKeys.VideoStreamKeys(client.SharedStreamKey!, unchecked((ulong)streamId));
        using var ctr = new AesCtr(vkey, viv);
        var idr = new byte[] { 0x65, 0x88, 0x84, 0x21, 0xff };
        var encrypted = ctr.Transform(MirrorStreamTests.LengthPrefixed(idr));
        await vs.WriteAsync(MirrorStreamTests.Header(encrypted.Length, 0, 0x10, 0, 500));
        await vs.WriteAsync(encrypted);

        var codecData = await codec.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1170, codecData.Width);
        var f = await frame.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(f.IsKeyframe);
        Assert.Equal(MirrorStreamTests.AnnexB(new byte[] { 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0x9a, 0x80, 0x80, 0x80, 0xa0 }, new byte[] { 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0 }, idr), f.Span.ToArray());

        // Audio: AES-CBC with the shared key and the eiv from SETUP.
        using var cbc = new AesCbc(client.SharedStreamKey!, client.Eiv);
        var payload = Enumerable.Range(0, 40).Select(i => (byte)i).ToArray();
        var packet = new byte[12 + payload.Length];
        packet[0] = 0x80;
        packet[1] = 0x60;
        packet[3] = 7;
        cbc.EncryptPacket(payload, packet.AsSpan(12));
        using var audioUdp = new UdpClient(AddressFamily.InterNetwork);
        await audioUdp.SendAsync(packet, packet.Length, new IPEndPoint(IPAddress.Loopback, client.AudioDataPort));
        var af = await audioFrame.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(payload, af.Data);
        Assert.Equal(7, af.SequenceNumber);

        var (fbStatus, _, _) = await client.RequestAsync("POST", "/feedback");
        Assert.Equal(200, fbStatus);

        var (tdStatus, tdHeaders, _) = await client.RequestAsync("TEARDOWN", "rtsp://127.0.0.1/1234567890", BinaryPlist.Write(new PlistDict()), "application/x-apple-binary-plist");
        Assert.Equal(200, tdStatus);
        Assert.Equal("close", tdHeaders["Connection"]);
        Assert.Equal("client ended the session", await disconnected.Task.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Null(receiver.ActiveClient);
    }

    [Fact]
    public async Task PasswordIsRequiredAtSetup()
    {
        using var client = new SimulatedIosClient();
        using var receiver = NewReceiver(client, password: "hunter2");
        receiver.Start();
        await client.ConnectAsync(receiver.RtspPort);
        var txt = BinaryPlist.ParseDict((await client.RequestAsync("GET", "/info")).Item3);
        Assert.NotNull(txt);
        await client.PairAsync();
        await client.FairPlayAsync();

        var (status, headers, _) = await client.SetupPhase1Async();
        Assert.Equal(401, status);
        var challenge = headers["WWW-Authenticate"];
        var nonce = DigestAuth.ParseFields(challenge)["nonce"];

        var wrong = DigestAuth.Authorize("SETUP", "rtsp://127.0.0.1/1234567890", "iTunes", "nope", nonce);
        var (status2, headers2, _) = await client.SetupPhase1Async(authorization: wrong);
        Assert.Equal(401, status2);
        var nonce2 = DigestAuth.ParseFields(headers2["WWW-Authenticate"])["nonce"];
        Assert.NotEqual(nonce, nonce2);

        var right = DigestAuth.Authorize("SETUP", "rtsp://127.0.0.1/1234567890", "iTunes", "hunter2", nonce2);
        var (status3, _, body3) = await client.SetupPhase1Async(authorization: right);
        Assert.Equal(200, status3);
        Assert.NotNull(body3);
        Assert.NotNull(receiver.ActiveClient);
    }

    [Fact]
    public async Task SecondClientTakesOverWhenAllowed()
    {
        using var first = new SimulatedIosClient();
        using var receiver = NewReceiver(first);
        var disconnected = new TaskCompletionSource<string>();
        receiver.ClientDisconnected += (_, reason) => disconnected.TrySetResult(reason);
        receiver.Start();
        await first.ConnectAsync(receiver.RtspPort);
        await first.PairAsync();
        await first.FairPlayAsync();
        Assert.Equal(200, (await first.SetupPhase1Async()).Status);

        using var second = new SimulatedIosClient();
        await second.ConnectAsync(receiver.RtspPort);
        await second.PairAsync();
        await second.FairPlayAsync();
        Assert.Equal(200, (await second.SetupPhase1Async()).Status);
        Assert.Equal("replaced by another device", await disconnected.Task.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task SecondClientIsRefusedWhenTakeoverDisabled()
    {
        using var first = new SimulatedIosClient();
        using var receiver = NewReceiver(first);
        receiver.Options.AllowTakeover = false;
        receiver.Start();
        await first.ConnectAsync(receiver.RtspPort);
        await first.PairAsync();
        await first.FairPlayAsync();
        Assert.Equal(200, (await first.SetupPhase1Async()).Status);

        using var second = new SimulatedIosClient();
        await second.ConnectAsync(receiver.RtspPort);
        await second.PairAsync();
        await second.FairPlayAsync();
        Assert.Equal(409, (await second.SetupPhase1Async()).Status);
        Assert.Equal("Mark's iPhone", receiver.ActiveClient?.Name);
    }

    [Fact]
    public async Task AirPlayVideoRequestsAreDeclined()
    {
        using var client = new SimulatedIosClient();
        using var receiver = NewReceiver(client);
        receiver.Start();
        using var tcp = new TcpClient();
        await tcp.ConnectAsync(IPAddress.Loopback, receiver.RtspPort);
        var s = tcp.GetStream();
        await s.WriteAsync("GET /server-info HTTP/1.1\r\nX-Apple-Session-ID: abc\r\n\r\n"u8.ToArray());
        var buf = new byte[1024];
        var n = await s.ReadAsync(buf).AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.StartsWith("HTTP/1.1 501 Not Implemented", System.Text.Encoding.ASCII.GetString(buf, 0, n));
    }
}
