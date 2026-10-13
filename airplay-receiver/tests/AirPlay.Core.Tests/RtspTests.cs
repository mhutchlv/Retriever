using System.Text;
using AirPlay.Rtsp;
using Xunit;

namespace AirPlay.Tests;

public class RtspTests
{
    [Fact]
    public void ParsesRequestWithBodyAndLeavesTheRest()
    {
        var text = "POST /fp-setup RTSP/1.0\r\nX-Apple-ProtocolVersion: 1\r\nContent-Length: 4\r\nContent-Type: application/octet-stream\r\nCSeq: 3\r\n\r\nABCDSETUP rtsp://1.2.3.4/123 RTSP/1.0\r\nCSeq: 4\r\n\r\n";
        var bytes = Encoding.ASCII.GetBytes(text);
        Assert.True(RtspParser.TryParse(bytes, out var req, out var consumed));
        Assert.Equal("POST", req!.Method);
        Assert.Equal("/fp-setup", req.Path);
        Assert.Equal("RTSP/1.0", req.Protocol);
        Assert.Equal("3", req.CSeq);
        Assert.Equal("application/octet-stream", req.ContentType);
        Assert.Equal("ABCD", Encoding.ASCII.GetString(req.Body));

        Assert.True(RtspParser.TryParse(bytes.AsSpan(consumed), out var second, out var consumed2));
        Assert.Equal("SETUP", second!.Method);
        Assert.Equal("/123", second.Path);
        Assert.Equal("rtsp://1.2.3.4/123", second.Uri);
        Assert.Empty(second.Body);
        Assert.Equal(bytes.Length, consumed + consumed2);
    }

    [Fact]
    public void NeedsMoreDataForPartialBody()
    {
        var bytes = Encoding.ASCII.GetBytes("POST /x RTSP/1.0\r\nContent-Length: 10\r\n\r\nabc");
        Assert.False(RtspParser.TryParse(bytes, out _, out _));
        Assert.False(RtspParser.TryParse(bytes.AsSpan(0, 5), out _, out _));
    }

    [Fact]
    public void HeaderNamesAreCaseInsensitive()
    {
        var bytes = Encoding.ASCII.GetBytes("GET /info RTSP/1.0\r\ncseq: 9\r\n\r\n");
        Assert.True(RtspParser.TryParse(bytes, out var req, out _));
        Assert.Equal("9", req!.CSeq);
        Assert.Equal("9", req.Header("CSEQ"));
    }

    [Fact]
    public void SerializesResponseLikeAirTunes()
    {
        var r = new RtspResponse("RTSP/1.0").AddHeader("Server", "AirTunes/220.68").AddHeader("CSeq", "3").WithBody(new byte[] { 1, 2, 3 }, "application/octet-stream");
        var text = Encoding.ASCII.GetString(r.Serialize());
        Assert.StartsWith("RTSP/1.0 200 OK\r\nServer: AirTunes/220.68\r\nCSeq: 3\r\nContent-Type: application/octet-stream\r\nContent-Length: 3\r\n\r\n", text);
        Assert.EndsWith("\u0001\u0002\u0003", text);

        var empty = new RtspResponse("RTSP/1.0", 401, "Unauthorized").AddHeader("WWW-Authenticate", "Digest realm=\"raop\", nonce=\"abc\"");
        Assert.Equal("RTSP/1.0 401 Unauthorized\r\nWWW-Authenticate: Digest realm=\"raop\", nonce=\"abc\"\r\n\r\n", Encoding.ASCII.GetString(empty.Serialize()));
    }
}
