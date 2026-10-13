using AirPlay.Crypto;

namespace AirPlay.Pairing;

public enum PairingStatus
{
    Initial,
    Setup,
    Handshake,
    Finished,
}

/// <summary>
/// Server side of the legacy AirPlay pair-setup / pair-verify exchange
/// (Ed25519 identities, X25519 ECDH, AES-128-CTR wrapped signatures).
/// </summary>
public sealed class PairingSession
{
    private readonly ReceiverIdentity _identity;
    private byte[]? _ecdhPrivate;
    private byte[]? _ecdhPublic;
    private byte[]? _ecdhTheirs;
    private byte[]? _edTheirs;
    private byte[]? _secret;

    public PairingSession(ReceiverIdentity identity)
    {
        _identity = identity;
    }

    public PairingStatus Status { get; private set; } = PairingStatus.Initial;

    /// <summary>The client's Ed25519 public key once pair-verify has started.</summary>
    public byte[]? ClientPublicKey => _edTheirs;

    /// <summary>The ECDH shared secret, or null before pair-verify.</summary>
    public byte[]? EcdhSecret => _secret;

    /// <summary>POST /pair-setup: the client sends its 32-byte Ed25519 key, we reply with ours.</summary>
    public byte[] Setup(ReadOnlySpan<byte> clientEdPublicKey)
    {
        if (clientEdPublicKey.Length != Ed25519Keys.PublicKeySize)
        {
            throw new ArgumentException("pair-setup payload must be 32 bytes.");
        }

        Status = PairingStatus.Setup;
        return _identity.PublicKey.ToArray();
    }

    /// <summary>
    /// POST /pair-verify, step 1 (payload starts with 0x01): 32-byte client X25519 key + 32-byte client Ed25519 key.
    /// Returns our 32-byte X25519 key followed by the AES-CTR encrypted 64-byte signature.
    /// </summary>
    public byte[] VerifyStep1(ReadOnlySpan<byte> payload)
    {
        if (payload.Length != 4 + 32 + 32 || payload[0] != 1)
        {
            throw new ArgumentException("pair-verify step 1 payload must be 68 bytes starting with 0x01.");
        }

        if (Status == PairingStatus.Finished)
        {
            throw new InvalidOperationException("pair-verify already finished.");
        }

        _ecdhTheirs = payload.Slice(4, 32).ToArray();
        _edTheirs = payload.Slice(36, 32).ToArray();
        (_ecdhPrivate, _ecdhPublic) = X25519Keys.GenerateKeyPair();
        _secret = X25519Keys.SharedSecret(_ecdhPrivate, _ecdhTheirs);
        Status = PairingStatus.Handshake;

        var message = new byte[64];
        _ecdhPublic.CopyTo(message, 0);
        _ecdhTheirs.CopyTo(message, 32);
        var signature = _identity.Sign(message);

        using var ctr = new AesCtr(AirPlayKeys.PairVerifyAesKey(_secret), AirPlayKeys.PairVerifyAesIv(_secret));
        var encrypted = ctr.Transform(signature);

        var response = new byte[32 + 64];
        _ecdhPublic.CopyTo(response, 0);
        encrypted.CopyTo(response, 32);
        return response;
    }

    /// <summary>POST /pair-verify, step 2 (payload starts with 0x00): 64-byte encrypted client signature.</summary>
    public bool VerifyStep2(ReadOnlySpan<byte> payload)
    {
        if (payload.Length != 4 + 64 || payload[0] != 0)
        {
            throw new ArgumentException("pair-verify step 2 payload must be 68 bytes starting with 0x00.");
        }

        if (Status != PairingStatus.Handshake || _secret == null || _ecdhPublic == null || _ecdhTheirs == null || _edTheirs == null)
        {
            return false;
        }

        using var ctr = new AesCtr(AirPlayKeys.PairVerifyAesKey(_secret), AirPlayKeys.PairVerifyAesIv(_secret));
        // The first 64 keystream bytes were used to encrypt our signature in step 1.
        ctr.Skip(64);
        var signature = ctr.Transform(payload.Slice(4, 64));

        var message = new byte[64];
        _ecdhTheirs.CopyTo(message, 0);
        _ecdhPublic.CopyTo(message, 32);
        if (!Ed25519Keys.Verify(signature, _edTheirs, message))
        {
            return false;
        }

        Status = PairingStatus.Finished;
        return true;
    }
}
