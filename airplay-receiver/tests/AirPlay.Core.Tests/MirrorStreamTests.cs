using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using AirPlay.Crypto;
using AirPlay.Streams;
using Xunit;

namespace AirPlay.Tests;

public class MirrorStreamTests
{
    private static readonly byte[] Sps = { 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0x9a, 0x80, 0x80, 0x80, 0xa0 };
    private static readonly byte[] Pps = { 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0 };

    internal static byte[] BuildAvcC()
    {
        var ms = new MemoryStream();
        ms.Write(new byte[] { 1, 0x64, 0x00, 0x28, 0xff, 0xe1 });
        ms.WriteByte((byte)(Sps.Length >> 8));
        ms.WriteByte((byte)Sps.Length);
        ms.Write(Sps);
        ms.WriteByte(1);
        ms.WriteByte((byte)(Pps.Length >> 8));
        ms.WriteByte((byte)Pps.Length);
        ms.Write(Pps);
        return ms.ToArray();
    }

    internal static byte[] LengthPrefixed(params byte[][] nals)
    {
        var ms = new MemoryStream();
        foreach (var nal in nals)
        {
            Span<byte> len = stackalloc byte[4];
            BinaryPrimitives.WriteInt32BigEndian(len, nal.Length);
            ms.Write(len);
            ms.Write(nal);
        }

        return ms.ToArray();
    }

    internal static byte[] AnnexB(params byte[][] nals)
    {
        var ms = new MemoryStream();
        foreach (var nal in nals)
        {
            ms.Write(new byte[] { 0, 0, 0, 1 });
            ms.Write(nal);
        }

        return ms.ToArray();
    }

    internal static byte[] Header(int payloadSize, byte type, byte subtype, byte option, ulong ntp, int width = 0, int height = 0)
    {
        var h = new byte[128];
        BinaryPrimitives.WriteInt32LittleEndian(h, payloadSize);
        h[4] = type;
        h[5] = subtype;
        h[6] = option;
        BinaryPrimitives.WriteUInt64LittleEndian(h.AsSpan(8), ntp);
        BinaryPrimitives.WriteSingleLittleEndian(h.AsSpan(16), width);
        BinaryPrimitives.WriteSingleLittleEndian(h.AsSpan(20), height);
        BinaryPrimitives.WriteSingleLittleEndian(h.AsSpan(40), width);
        BinaryPrimitives.WriteSingleLittleEndian(h.AsSpan(44), height);
        BinaryPrimitives.WriteSingleLittleEndian(h.AsSpan(56), width);
        BinaryPrimitives.WriteSingleLittleEndian(h.AsSpan(60), height);
        return h;
    }

    [Fact]
    public void ParsesAvcCIntoAnnexB()
    {
        var result = MirrorStreamReceiver.ParseAvcC(BuildAvcC());
        Assert.Equal(AnnexB(Sps, Pps), result);
    }

    [Fact]
    public void ConvertsLengthPrefixesAndDetectsKeyframes()
    {
        var idr = new byte[] { 0x65, 0x88, 0x84, 0x00 };
        var sei = new byte[] { 0x06, 0x05, 0x01 };
        var data = LengthPrefixed(sei, idr);
        Assert.True(MirrorStreamReceiver.ConvertLengthPrefixesToStartCodes(data, VideoCodec.H264, out var key));
        Assert.True(key);
        Assert.Equal(AnnexB(sei, idr), data);

        var p = LengthPrefixed(new byte[] { 0x41, 0x9a, 0x00 });
        Assert.True(MirrorStreamReceiver.ConvertLengthPrefixesToStartCodes(p, VideoCodec.H264, out key));
        Assert.False(key);

        var bad = new byte[] { 0, 0, 0, 9, 0x65, 0x00 };
        Assert.False(MirrorStreamReceiver.ConvertLengthPrefixesToStartCodes(bad, VideoCodec.H264, out _));
        var forbidden = LengthPrefixed(new byte[] { 0xE5, 0x00 });
        Assert.False(MirrorStreamReceiver.ConvertLengthPrefixesToStartCodes(forbidden, VideoCodec.H264, out _));
    }

    [Fact]
    public async Task ReceivesCodecDataAndEncryptedFramesOverTcp()
    {
        var sharedKey = Enumerable.Range(0, 16).Select(i => (byte)(i * 17)).ToArray();
        var streamId = unchecked((ulong)-4903871290523402176L);
        var log = Log.Null;
        using var receiver = new MirrorStreamReceiver(log, sharedKey, streamId, 0);
        var codecTcs = new TaskCompletionSource<VideoCodecData>();
        var frames = new List<VideoFrame>();
        var frameTcs = new TaskCompletionSource<bool>();
        receiver.CodecData += d => codecTcs.TrySetResult(d);
        receiver.Frame += f =>
        {
            lock (frames)
            {
                frames.Add(f);
                if (frames.Count == 3)
                {
                    frameTcs.TrySetResult(true);
                }
            }
        };
        receiver.Start();
        Assert.NotEqual(0, receiver.Port);

        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, receiver.Port);
        var stream = client.GetStream();

        var avcc = BuildAvcC();
        await stream.WriteAsync(Header(avcc.Length, 1, 0, 0x16, 1000, 1170, 2532));
        await stream.WriteAsync(avcc);

        var (key, iv) = AirPlayKeys.VideoStreamKeys(sharedKey, streamId);
        using var ctr = new AesCtr(key, iv);
        var idr = Enumerable.Range(0, 1001).Select(i => (byte)(i == 0 ? 0x65 : i)).ToArray();
        var p1 = Enumerable.Range(0, 333).Select(i => (byte)(i == 0 ? 0x41 : i * 3)).ToArray();
        var p2 = Enumerable.Range(0, 17).Select(i => (byte)(i == 0 ? 0x41 : i * 5)).ToArray();
        foreach (var (nal, subtype, ntp) in new[] { (idr, (byte)0x10, 1000UL), (p1, (byte)0x00, 1001UL), (p2, (byte)0x00, 1002UL) })
        {
            var plain = LengthPrefixed(nal);
            var encrypted = ctr.Transform(plain); // continuous keystream across packets, odd sizes
            await stream.WriteAsync(Header(encrypted.Length, 0, subtype, 0, ntp));
            await stream.WriteAsync(encrypted);
        }

        var codec = await codecTcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(VideoCodec.H264, codec.Codec);
        Assert.Equal(1170, codec.Width);
        Assert.Equal(2532, codec.Height);
        Assert.Equal(AnnexB(Sps, Pps), codec.ParameterSets);

        await frameTcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        VideoFrame[] got;
        lock (frames)
        {
            got = frames.ToArray();
        }

        Assert.True(got[0].IsKeyframe);
        Assert.True(got[0].IncludesParameterSets);
        Assert.Equal(AnnexB(Sps, Pps, idr), got[0].Span.ToArray());
        Assert.Equal(1000UL, got[0].NtpTimestamp);
        Assert.False(got[1].IsKeyframe);
        Assert.False(got[1].IncludesParameterSets);
        Assert.Equal(AnnexB(p1), got[1].Span.ToArray());
        Assert.Equal(AnnexB(p2), got[2].Span.ToArray());
        Assert.Equal(3, receiver.FramesReceived);
    }
}
