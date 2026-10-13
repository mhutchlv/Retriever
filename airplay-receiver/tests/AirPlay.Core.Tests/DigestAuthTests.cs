using AirPlay.Pairing;
using Xunit;

namespace AirPlay.Tests;

public class DigestAuthTests
{
    [Fact]
    public void Rfc2617ExampleVerifies()
    {
        const string auth = "Digest username=\"Mufasa\", realm=\"testrealm@host.com\", nonce=\"dcd98b7102dd2f0e8b11d0f600bfb0c093\", uri=\"/dir/index.html\", qop=auth, nc=00000001, cnonce=\"0a4f113b\", response=\"6629fae49393a05397450978507c4ef1\", opaque=\"5ccc069c403ebaf9f0171e9517f40e41\"";
        Assert.True(DigestAuth.Verify("GET", auth, "Circle Of Life", "dcd98b7102dd2f0e8b11d0f600bfb0c093"));
        Assert.False(DigestAuth.Verify("GET", auth, "wrong", "dcd98b7102dd2f0e8b11d0f600bfb0c093"));
        Assert.False(DigestAuth.Verify("GET", auth, "Circle Of Life", "othernonce"));
        Assert.False(DigestAuth.Verify("POST", auth, "Circle Of Life", "dcd98b7102dd2f0e8b11d0f600bfb0c093"));
    }

    [Fact]
    public void ClientHeaderRoundTrips()
    {
        var nonce = DigestAuth.NewNonce();
        Assert.Equal(32, nonce.Length);
        var header = DigestAuth.Authorize("SETUP", "rtsp://192.168.1.5/123", "iTunes", "s3cret", nonce);
        Assert.True(DigestAuth.Verify("SETUP", header, "s3cret", nonce));
        Assert.False(DigestAuth.Verify("SETUP", header, "s3cre7", nonce));
        var fields = DigestAuth.ParseFields(header);
        Assert.Equal("iTunes", fields["username"]);
        Assert.Equal("raop", fields["realm"]);
    }
}
