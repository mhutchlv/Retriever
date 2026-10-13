namespace AirPlay.FairPlay;

/// <summary>
/// The two-phase /fp-setup exchange. Phase 1 (16-byte request) is answered from a table of
/// fixed 142-byte replies; phase 2 (164-byte request) is acknowledged with an echo of its tail.
/// The 164-byte message is kept because it seeds the key decryption done at SETUP time.
/// Only FairPlay version 3 is handled (what iOS sends to third-party receivers).
/// </summary>
public sealed class FairPlaySession
{
    public const int SetupRequestLength = 16;
    public const int SetupReplyLength = 142;
    public const int HandshakeRequestLength = 164;
    public const int HandshakeReplyLength = 32;

    private static readonly byte[] FpHeader = { 0x46, 0x50, 0x4c, 0x59, 0x03, 0x01, 0x04, 0x00, 0x00, 0x00, 0x00, 0x14 };

    private readonly IFairPlayDecryptor _decryptor;
    private byte[]? _keyMessage;

    public FairPlaySession(IFairPlayDecryptor decryptor)
    {
        _decryptor = decryptor;
    }

    public bool HasKeyMessage => _keyMessage != null;

    public byte[] Setup(ReadOnlySpan<byte> request)
    {
        if (request.Length != SetupRequestLength)
        {
            throw new ArgumentException("fp-setup phase 1 request must be 16 bytes.");
        }

        if (request[4] != 0x03)
        {
            throw new NotSupportedException($"Unsupported FairPlay version 0x{request[4]:x2}; only version 3 is supported.");
        }

        var mode = request[14];
        if (mode > 3)
        {
            throw new NotSupportedException($"Unsupported FairPlay mode {mode}.");
        }

        _keyMessage = null;
        return FairPlayTables.Reply[mode].ToArray();
    }

    public byte[] Handshake(ReadOnlySpan<byte> request)
    {
        if (request.Length != HandshakeRequestLength)
        {
            throw new ArgumentException("fp-setup phase 2 request must be 164 bytes.");
        }

        if (request[4] != 0x03)
        {
            throw new NotSupportedException($"Unsupported FairPlay version 0x{request[4]:x2}.");
        }

        _keyMessage = request.ToArray();
        var reply = new byte[HandshakeReplyLength];
        FpHeader.CopyTo(reply, 0);
        request.Slice(144, 20).CopyTo(reply.AsSpan(12));
        return reply;
    }

    /// <summary>Decrypts the 72-byte "ekey" from SETUP into the 16-byte AES key.</summary>
    public byte[] DecryptKey(ReadOnlySpan<byte> encryptedKey)
    {
        if (_keyMessage == null)
        {
            throw new InvalidOperationException("fp-setup handshake has not completed.");
        }

        return _decryptor.DecryptKey(_keyMessage, encryptedKey);
    }
}
