using System.Security.Cryptography;

namespace AirPlay.Crypto;

/// <summary>AES-128-CBC without padding, re-keyed with the same IV for every packet (RAOP audio style).</summary>
public sealed class AesCbc : IDisposable
{
    private readonly Aes _aes;
    private readonly byte[] _iv;

    public AesCbc(ReadOnlySpan<byte> key, ReadOnlySpan<byte> iv)
    {
        if (key.Length != 16 || iv.Length != 16)
        {
            throw new ArgumentException("AES-128-CBC needs a 16-byte key and a 16-byte IV.");
        }

        _aes = Aes.Create();
        _aes.Key = key.ToArray();
        _iv = iv.ToArray();
    }

    /// <summary>Decrypts the whole-block prefix of <paramref name="input"/>; trailing partial-block bytes are copied as-is.</summary>
    public int DecryptPacket(ReadOnlySpan<byte> input, Span<byte> output)
    {
        var encrypted = input.Length / 16 * 16;
        if (encrypted > 0)
        {
            _aes.DecryptCbc(input[..encrypted], _iv, output[..encrypted], PaddingMode.None);
        }

        input[encrypted..].CopyTo(output[encrypted..]);
        return input.Length;
    }

    public int EncryptPacket(ReadOnlySpan<byte> input, Span<byte> output)
    {
        var encrypted = input.Length / 16 * 16;
        if (encrypted > 0)
        {
            _aes.EncryptCbc(input[..encrypted], _iv, output[..encrypted], PaddingMode.None);
        }

        input[encrypted..].CopyTo(output[encrypted..]);
        return input.Length;
    }

    public void Dispose() => _aes.Dispose();
}
