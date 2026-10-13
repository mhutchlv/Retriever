using System.Security.Cryptography;
using System.Text;

namespace AirPlay.Crypto;

/// <summary>Key derivations used by the legacy (iOS 9+) AirPlay mirroring protocol.</summary>
public static class AirPlayKeys
{
    /// <summary>
    /// The 16-byte key that both audio and video derive from:
    /// SHA-512(fairplayKey || ecdhSecret)[0..16]. Without pairing (no ECDH secret) the FairPlay key is used as-is.
    /// </summary>
    public static byte[] SharedStreamKey(ReadOnlySpan<byte> fairplayKey, byte[]? ecdhSecret)
    {
        if (ecdhSecret is null)
        {
            return fairplayKey.ToArray();
        }

        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA512);
        sha.AppendData(fairplayKey);
        sha.AppendData(ecdhSecret);
        return sha.GetHashAndReset()[..16];
    }

    /// <summary>Mirror video AES-CTR key and IV for a stream: SHA-512("AirPlayStreamKey" + id || key)[0..16] etc.</summary>
    public static (byte[] Key, byte[] Iv) VideoStreamKeys(ReadOnlySpan<byte> sharedKey, ulong streamConnectionId)
    {
        var key = SaltedHash("AirPlayStreamKey" + streamConnectionId.ToString(System.Globalization.CultureInfo.InvariantCulture), sharedKey);
        var iv = SaltedHash("AirPlayStreamIV" + streamConnectionId.ToString(System.Globalization.CultureInfo.InvariantCulture), sharedKey);
        return (key, iv);
    }

    public static byte[] PairVerifyAesKey(ReadOnlySpan<byte> ecdhSecret) => SaltedHash("Pair-Verify-AES-Key", ecdhSecret);

    public static byte[] PairVerifyAesIv(ReadOnlySpan<byte> ecdhSecret) => SaltedHash("Pair-Verify-AES-IV", ecdhSecret);

    private static byte[] SaltedHash(string salt, ReadOnlySpan<byte> material)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA512);
        sha.AppendData(Encoding.ASCII.GetBytes(salt));
        sha.AppendData(material);
        return sha.GetHashAndReset()[..16];
    }
}
