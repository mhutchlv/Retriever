using System.Net;
using AirPlay.Dns;
using Xunit;

namespace AirPlay.Tests;

public class DnsTests
{
    [Fact]
    public void NamesCompareCaseInsensitively()
    {
        var a = DnsName.Parse("_AirPlay._tcp.local");
        var b = DnsName.Parse("_airplay._tcp.LOCAL.");
        Assert.Equal(a, b);
        Assert.True(DnsName.Instance("Mark's PC", a).EndsWith(b));
        Assert.Equal("Mark's PC", DnsName.Instance("Mark's PC", a).Labels[0]);
    }

    [Fact]
    public void ResponseRoundTripsThroughReader()
    {
        var type = DnsName.Parse("_airplay._tcp.local");
        var instance = DnsName.Instance("Living Room PC", type);
        var host = DnsName.Parse("airplay-aabbccddeeff.local");
        var w = new DnsWriter(0);
        w.AddPtr(DnsName.Parse("_services._dns-sd._udp.local"), type, 4500);
        w.AddPtr(type, instance, 4500);
        w.AddSrv(instance, 0, 0, 7000, host, 4500);
        w.AddTxt(instance, new[] { "deviceid=aa:bb:cc:dd:ee:ff", "features=0x5A7FFEE6,0x0" }, 4500);
        w.AddAddress(host, IPAddress.Parse("192.168.1.20"), 120);
        var packet = w.ToArray();

        var msg = DnsReader.Parse(packet);
        Assert.True(msg.IsResponse);
        Assert.Empty(msg.Questions);
        Assert.Equal(5, msg.Answers.Count);
        Assert.Equal(DnsType.PTR, msg.Answers[1].Type);
        Assert.Equal(instance, msg.Answers[1].PtrTarget);
        Assert.Equal(type, msg.Answers[1].Name);
        Assert.Equal(DnsType.SRV, msg.Answers[2].Type);
        Assert.Equal(instance, msg.Answers[2].Name);
        Assert.Equal(DnsType.TXT, msg.Answers[3].Type);
        Assert.Equal(DnsType.A, msg.Answers[4].Type);
        Assert.Equal(host, msg.Answers[4].Name);

        // Compression must have kicked in: the full packet is far shorter than the uncompressed names.
        Assert.True(packet.Length < 250, $"packet is {packet.Length} bytes");
    }

    [Fact]
    public void ParsesQueryWithUnicastBit()
    {
        var packet = new byte[]
        {
            0x12, 0x34, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            8, (byte)'_', (byte)'a', (byte)'i', (byte)'r', (byte)'p', (byte)'l', (byte)'a', (byte)'y',
            4, (byte)'_', (byte)'t', (byte)'c', (byte)'p',
            5, (byte)'l', (byte)'o', (byte)'c', (byte)'a', (byte)'l', 0,
            0x00, 0x0C, 0x80, 0x01,
        };
        var msg = DnsReader.Parse(packet);
        Assert.False(msg.IsResponse);
        var q = Assert.Single(msg.Questions);
        Assert.Equal(DnsName.Parse("_airplay._tcp.local"), q.Name);
        Assert.Equal(DnsType.PTR, q.Type);
        Assert.True(q.UnicastResponse);
        Assert.Equal(1, q.Class);
    }

    [Fact]
    public void TxtRecordBytesAreLengthPrefixed()
    {
        var svc = new MdnsService("_airplay._tcp.local", "X", 7000, new[] { new KeyValuePair<string, string>("vv", "2"), new KeyValuePair<string, string>("pw", "false") });
        var bytes = svc.TxtRecordBytes();
        Assert.Equal(new byte[] { 4, (byte)'v', (byte)'v', (byte)'=', (byte)'2', 8, (byte)'p', (byte)'w', (byte)'=', (byte)'f', (byte)'a', (byte)'l', (byte)'s', (byte)'e' }, bytes);
    }
}
