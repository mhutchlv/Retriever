using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using AirPlay.Crypto;
using AirPlay.Streams;
using Xunit;

namespace AirPlay.Tests;

public class AudioStreamTests
{
    [Fact]
    public void JitterBufferReordersDropsDuplicatesAndSkipsHoles()
    {
        var emitted = new List<ushort>();
        var resends = new List<(ushort, ushort)>();
        var buffer = new AudioStreamReceiver.JitterBuffer(f => emitted.Add(f.SequenceNumber), (s, c) => resends.Add((s, c)));
        AudioFrame F(ushort seq) => new(Array.Empty<byte>(), seq, seq);

        buffer.Enqueue(F(65533));
        buffer.Enqueue(F(65535)); // 65534 missing
        Assert.Equal(new ushort[] { 65533 }, emitted);
        Assert.Equal(new[] { ((ushort)65534, (ushort)1) }, resends);
        buffer.Enqueue(F(65534));
        Assert.Equal(new ushort[] { 65533, 65534, 65535 }, emitted);
        buffer.Enqueue(F(0)); // wraps
        buffer.Enqueue(F(0)); // duplicate
        buffer.Enqueue(F(65535)); // late
        Assert.Equal(new ushort[] { 65533, 65534, 65535, 0 }, emitted);

        // A hole that never fills is skipped after enough packets pile up.
        for (ushort s = 2; s < 70; s++)
        {
            buffer.Enqueue(F(s));
        }

        Assert.Equal(2, emitted[4]);
        Assert.Contains((ushort)69, emitted);
        Assert.DoesNotContain((ushort)1, emitted);
    }

    [Fact]
    public async Task ReceivesDecryptsAndReordersRtpPackets()
    {
        var key = Enumerable.Range(0, 16).Select(i => (byte)(i + 1)).ToArray();
        var iv = Enumerable.Range(0, 16).Select(i => (byte)(0x80 + i)).ToArray();
        var info = new AudioStreamInfo(AudioCodec.AacEld, 480, 44100, 2, 0x1000000);
        using var receiver = new AudioStreamReceiver(Log.Null, key, iv, IPAddress.Loopback, 0, info, 0, 0);
        var got = new List<AudioFrame>();
        var done = new TaskCompletionSource<bool>();
        receiver.Frame += f =>
        {
            lock (got)
            {
                got.Add(f);
                if (got.Count == 4)
                {
                    done.TrySetResult(true);
                }
            }
        };
        receiver.Start();

        using var cipher = new AesCbc(key, iv);
        using var udp = new UdpClient(AddressFamily.InterNetwork);
        var target = new IPEndPoint(IPAddress.Loopback, receiver.DataPort);

        byte[] Packet(ushort seq, uint ts, byte[] payload)
        {
            var p = new byte[12 + payload.Length];
            p[0] = 0x80;
            p[1] = 0x60;
            BinaryPrimitives.WriteUInt16BigEndian(p.AsSpan(2), seq);
            BinaryPrimitives.WriteUInt32BigEndian(p.AsSpan(4), ts);
            cipher.EncryptPacket(payload, p.AsSpan(12));
            return p;
        }

        var payloads = Enumerable.Range(0, 4).Select(n => Enumerable.Range(0, 37 + n).Select(i => (byte)(n * 50 + i)).ToArray()).ToArray();
        await udp.SendAsync(Packet(10, 480 * 10, payloads[0]), target);
        await udp.SendAsync(Packet(12, 480 * 12, payloads[2]), target); // out of order
        await udp.SendAsync(Packet(11, 480 * 11, payloads[1]), target);
        await udp.SendAsync(Packet(11, 480 * 11, payloads[1]), target); // AAC-ELD packets are sent repeatedly
        await udp.SendAsync(new byte[] { 0x80, 0x60, 0, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x68, 0x34, 0x00 }, target); // no-data marker
        await udp.SendAsync(Packet(13, 480 * 13, payloads[3]), target);

        await done.Task.WaitAsync(TimeSpan.FromSeconds(5));
        AudioFrame[] frames;
        lock (got)
        {
            frames = got.ToArray();
        }

        Assert.Equal(new ushort[] { 10, 11, 12, 13 }, frames.Select(f => f.SequenceNumber));
        Assert.Equal(480u * 12, frames[2].RtpTimestamp);
        for (var i = 0; i < 4; i++)
        {
            Assert.Equal(payloads[i], frames[i].Data);
        }
    }
}
