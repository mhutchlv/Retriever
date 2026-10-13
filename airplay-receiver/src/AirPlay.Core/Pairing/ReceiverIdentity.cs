using System.Security.Cryptography;
using AirPlay.Crypto;

namespace AirPlay.Pairing;

/// <summary>
/// The receiver's long-lived Ed25519 identity. Its public key is advertised in the
/// "pk" TXT record and returned from /pair-setup, so it should stay stable across runs.
/// </summary>
public sealed class ReceiverIdentity
{
    private ReceiverIdentity(byte[] seed)
    {
        Seed = seed;
        PublicKey = Ed25519Keys.PublicKeyFromSeed(seed);
    }

    public byte[] Seed { get; }
    public byte[] PublicKey { get; }
    public string PublicKeyHex => Hex.ToLower(PublicKey);

    public static ReceiverIdentity Generate() => new(Ed25519Keys.GenerateSeed());

    public static ReceiverIdentity FromSeed(ReadOnlySpan<byte> seed)
    {
        if (seed.Length != Ed25519Keys.SeedSize)
        {
            throw new ArgumentException("Ed25519 seed must be 32 bytes.");
        }

        return new ReceiverIdentity(seed.ToArray());
    }

    /// <summary>Deterministic identity derived from a device id (what UxPlay does without a key file).</summary>
    public static ReceiverIdentity FromDeviceId(string deviceId)
    {
        var hash = SHA512.HashData(System.Text.Encoding.ASCII.GetBytes("Ed25519 key salt:" + deviceId));
        return new ReceiverIdentity(hash[..32]);
    }

    /// <summary>Loads the identity from <paramref name="path"/>, creating and saving a new one if absent or unreadable.</summary>
    public static ReceiverIdentity LoadOrCreate(string path, Log? log = null)
    {
        try
        {
            if (File.Exists(path))
            {
                var seed = Hex.Parse(File.ReadAllText(path));
                if (seed.Length == Ed25519Keys.SeedSize)
                {
                    return new ReceiverIdentity(seed);
                }

                log?.Warn($"Identity file {path} is malformed; generating a new identity.");
            }
        }
        catch (Exception ex)
        {
            log?.Warn($"Could not read identity file {path}: {ex.Message}");
        }

        var identity = Generate();
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
            File.WriteAllText(path, identity.SeedHex);
        }
        catch (Exception ex)
        {
            log?.Warn($"Could not save identity file {path}: {ex.Message}");
        }

        return identity;
    }

    public string SeedHex => Hex.ToLower(Seed);

    public byte[] Sign(ReadOnlySpan<byte> message) => Ed25519Keys.Sign(Seed, PublicKey, message);
}
