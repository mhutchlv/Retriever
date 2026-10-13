using AirPlay.Crypto;
using Xunit;

namespace AirPlay.Tests;

public class CryptoTests
{
    // NIST SP 800-38A, F.5.1 CTR-AES128.Encrypt
    private static readonly byte[] Key = Hex.Parse("2b7e151628aed2a6abf7158809cf4f3c");
    private static readonly byte[] Iv = Hex.Parse("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
    private static readonly byte[] Plain = Hex.Parse("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710");
    private static readonly byte[] Cipher = Hex.Parse("874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff5ae4df3edbd5d35e5b4f09020db03eab1e031dda2fbe03d1792170a0f3009cee");

    [Fact]
    public void AesCtrMatchesNistVector()
    {
        using var ctr = new AesCtr(Key, Iv);
        Assert.Equal(Cipher, ctr.Transform(Plain));
    }

    [Fact]
    public void AesCtrKeystreamIsContinuousAcrossOddChunks()
    {
        using var ctr = new AesCtr(Key, Iv);
        var output = new byte[Plain.Length];
        var pos = 0;
        foreach (var size in new[] { 1, 7, 16, 3, 29, 8 })
        {
            ctr.Transform(Plain.AsSpan(pos, size), output.AsSpan(pos, size));
            pos += size;
        }

        Assert.Equal(Plain.Length, pos);
        Assert.Equal(Cipher, output);
    }

    [Fact]
    public void AesCtrSkipAdvancesKeystream()
    {
        using var a = new AesCtr(Key, Iv);
        a.Skip(37);
        var tail = a.Transform(Plain.AsSpan(37));
        Assert.Equal(Cipher.AsSpan(37).ToArray(), tail);
    }

    [Fact]
    public void AesCtrCounterWrapsAcrossBlockBoundary()
    {
        var iv = Hex.Parse("ffffffffffffffffffffffffffffffff");
        using var one = new AesCtr(Key, iv);
        using var two = new AesCtr(Key, iv);
        var big = new byte[1024 * 5];
        var expected = two.Transform(big);
        var actual = new byte[big.Length];
        for (var i = 0; i < big.Length; i += 100)
        {
            var n = Math.Min(100, big.Length - i);
            one.Transform(big.AsSpan(i, n), actual.AsSpan(i, n));
        }

        Assert.Equal(expected, actual);
    }

    [Fact]
    public void AesCbcLeavesPartialTrailingBlockClear()
    {
        var key = new byte[16];
        var iv = new byte[16];
        for (var i = 0; i < 16; i++)
        {
            key[i] = (byte)i;
            iv[i] = (byte)(0xF0 + i);
        }

        using var enc = new AesCbc(key, iv);
        using var dec = new AesCbc(key, iv);
        var payload = Enumerable.Range(0, 45).Select(i => (byte)(i * 3)).ToArray();
        var cipher = new byte[payload.Length];
        enc.EncryptPacket(payload, cipher);
        Assert.Equal(payload[32..], cipher[32..]);
        Assert.NotEqual(payload[..32], cipher[..32]);
        var plain = new byte[payload.Length];
        dec.DecryptPacket(cipher, plain);
        Assert.Equal(payload, plain);
        // Every packet restarts from the IV.
        dec.DecryptPacket(cipher, plain);
        Assert.Equal(payload, plain);
    }

    [Fact]
    public void KeyDerivationsAreDeterministicAndDistinct()
    {
        var fp = Enumerable.Range(0, 16).Select(i => (byte)i).ToArray();
        var secret = Enumerable.Range(0, 32).Select(i => (byte)(255 - i)).ToArray();
        var shared = AirPlayKeys.SharedStreamKey(fp, secret);
        Assert.Equal(16, shared.Length);
        Assert.Equal(shared, AirPlayKeys.SharedStreamKey(fp, secret));
        Assert.Equal(fp, AirPlayKeys.SharedStreamKey(fp, null));
        var (k1, iv1) = AirPlayKeys.VideoStreamKeys(shared, 1);
        var (k2, iv2) = AirPlayKeys.VideoStreamKeys(shared, 2);
        Assert.NotEqual(k1, k2);
        Assert.NotEqual(iv1, iv2);
        Assert.NotEqual(k1, iv1);
        Assert.NotEqual(AirPlayKeys.PairVerifyAesKey(secret), AirPlayKeys.PairVerifyAesIv(secret));
    }

    [Fact]
    public void Ed25519SignsAndVerifies()
    {
        var seed = Ed25519Keys.GenerateSeed();
        var pk = Ed25519Keys.PublicKeyFromSeed(seed);
        var msg = new byte[64];
        var sig = Ed25519Keys.Sign(seed, pk, msg);
        Assert.True(Ed25519Keys.Verify(sig, pk, msg));
        sig[0] ^= 1;
        Assert.False(Ed25519Keys.Verify(sig, pk, msg));
    }

    [Fact]
    public void X25519AgreesOnBothSides()
    {
        var (aPriv, aPub) = X25519Keys.GenerateKeyPair();
        var (bPriv, bPub) = X25519Keys.GenerateKeyPair();
        Assert.Equal(X25519Keys.SharedSecret(aPriv, bPub), X25519Keys.SharedSecret(bPriv, aPub));
    }
}
