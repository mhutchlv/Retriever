using Org.BouncyCastle.Math.EC.Rfc7748;
using Org.BouncyCastle.Math.EC.Rfc8032;
using Org.BouncyCastle.Security;

namespace AirPlay.Crypto;

/// <summary>Thin wrappers over BouncyCastle's RFC 7748 / RFC 8032 implementations.</summary>
public static class Ed25519Keys
{
    public const int SeedSize = 32;
    public const int PublicKeySize = 32;
    public const int SignatureSize = 64;

    public static byte[] GenerateSeed()
    {
        var seed = new byte[SeedSize];
        Ed25519.GeneratePrivateKey(new SecureRandom(), seed);
        return seed;
    }

    public static byte[] PublicKeyFromSeed(ReadOnlySpan<byte> seed)
    {
        var pk = new byte[PublicKeySize];
        Ed25519.GeneratePublicKey(seed.ToArray(), 0, pk, 0);
        return pk;
    }

    public static byte[] Sign(ReadOnlySpan<byte> seed, ReadOnlySpan<byte> publicKey, ReadOnlySpan<byte> message)
    {
        var sig = new byte[SignatureSize];
        var m = message.ToArray();
        Ed25519.Sign(seed.ToArray(), 0, publicKey.ToArray(), 0, m, 0, m.Length, sig, 0);
        return sig;
    }

    public static bool Verify(ReadOnlySpan<byte> signature, ReadOnlySpan<byte> publicKey, ReadOnlySpan<byte> message)
    {
        if (signature.Length != SignatureSize || publicKey.Length != PublicKeySize)
        {
            return false;
        }

        var m = message.ToArray();
        return Ed25519.Verify(signature.ToArray(), 0, publicKey.ToArray(), 0, m, 0, m.Length);
    }
}

public static class X25519Keys
{
    public const int KeySize = 32;

    public static (byte[] PrivateKey, byte[] PublicKey) GenerateKeyPair()
    {
        var sk = new byte[KeySize];
        X25519.GeneratePrivateKey(new SecureRandom(), sk);
        var pk = new byte[KeySize];
        X25519.GeneratePublicKey(sk, 0, pk, 0);
        return (sk, pk);
    }

    public static byte[] SharedSecret(ReadOnlySpan<byte> privateKey, ReadOnlySpan<byte> peerPublicKey)
    {
        var secret = new byte[KeySize];
        X25519.CalculateAgreement(privateKey.ToArray(), 0, peerPublicKey.ToArray(), 0, secret, 0);
        return secret;
    }
}
