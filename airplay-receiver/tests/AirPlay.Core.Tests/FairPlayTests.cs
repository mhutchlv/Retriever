using AirPlay.FairPlay;
using Xunit;

namespace AirPlay.Tests;

public class FairPlayTests
{
    private static byte[] SetupRequest(byte mode)
    {
        var req = new byte[16];
        "FPLY"u8.CopyTo(req);
        req[4] = 3;
        req[5] = 1;
        req[6] = 1;
        req[11] = 4;
        req[14] = mode;
        return req;
    }

    private static byte[] HandshakeRequest()
    {
        var req = new byte[164];
        for (var i = 0; i < req.Length; i++)
        {
            req[i] = (byte)((i * 7 + 3) & 0xff);
        }

        "FPLY"u8.CopyTo(req);
        req[4] = 3;
        req[5] = 1;
        req[6] = 3;
        req[12] = 0;
        return req;
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void SetupReturnsFixedReplyForMode(byte mode)
    {
        var fp = new FairPlaySession(new ThrowingDecryptor());
        var reply = fp.Setup(SetupRequest(mode));
        Assert.Equal(142, reply.Length);
        Assert.Equal("FPLY"u8.ToArray(), reply[..4]);
        Assert.Equal(mode, reply[13]);
        Assert.Equal(0x82, reply[11]);
    }

    [Fact]
    public void SetupRejectsOtherVersions()
    {
        var fp = new FairPlaySession(new ThrowingDecryptor());
        var req = SetupRequest(0);
        req[4] = 2;
        Assert.Throws<NotSupportedException>(() => fp.Setup(req));
    }

    [Fact]
    public void HandshakeEchoesTail()
    {
        var fp = new FairPlaySession(new ThrowingDecryptor());
        var req = HandshakeRequest();
        var reply = fp.Handshake(req);
        Assert.Equal(32, reply.Length);
        Assert.Equal(new byte[] { 0x46, 0x50, 0x4c, 0x59, 0x03, 0x01, 0x04, 0x00, 0x00, 0x00, 0x00, 0x14 }, reply[..12]);
        Assert.Equal(req[144..164], reply[12..]);
        Assert.True(fp.HasKeyMessage);
    }

    [Fact]
    public void NativePlayfairMatchesReferenceVectors()
    {
        // Expected values computed by running the vendored C library (native/playfair) with these inputs.
        Assert.True(NativePlayfair.IsAvailable, "libplayfair must be built next to the test assembly");
        var decryptor = new NativePlayfair();
        var fp = new FairPlaySession(decryptor);
        var msg = HandshakeRequest();
        fp.Handshake(msg);
        var cipher = new byte[72];
        for (var i = 0; i < cipher.Length; i++)
        {
            cipher[i] = (byte)((i * 13 + 1) & 0xff);
        }

        Assert.Equal("ed5b981169fb119845a97379a8ec5e50", Hex.ToLower(fp.DecryptKey(cipher)));

        msg[12] = 3;
        fp.Handshake(msg);
        Assert.Equal("7d341eeb2d7fc1b376ec9edd94fdcbe8", Hex.ToLower(fp.DecryptKey(cipher)));
    }

    private sealed class ThrowingDecryptor : IFairPlayDecryptor
    {
        public byte[] DecryptKey(ReadOnlySpan<byte> fpSetupMessage, ReadOnlySpan<byte> encryptedKey) => throw new InvalidOperationException();
    }
}
