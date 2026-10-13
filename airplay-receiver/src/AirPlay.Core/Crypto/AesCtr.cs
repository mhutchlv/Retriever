using System.Security.Cryptography;

namespace AirPlay.Crypto;

/// <summary>
/// AES-128-CTR with a continuous keystream (the full 128-bit counter is incremented big-endian,
/// matching OpenSSL's EVP_aes_128_ctr). Encryption and decryption are the same operation.
/// Not thread-safe.
/// </summary>
public sealed class AesCtr : IDisposable
{
    private const int Block = 16;
    private const int ChunkBlocks = 64;

    private readonly Aes _aes;
    private readonly byte[] _counter = new byte[Block];
    private readonly byte[] _counterChunk = new byte[Block * ChunkBlocks];
    private readonly byte[] _keystream = new byte[Block * ChunkBlocks];
    private int _keystreamAvailable;
    private int _keystreamPos;

    public AesCtr(ReadOnlySpan<byte> key, ReadOnlySpan<byte> iv)
    {
        if (key.Length != 16 || iv.Length != 16)
        {
            throw new ArgumentException("AES-128-CTR needs a 16-byte key and a 16-byte IV.");
        }

        _aes = Aes.Create();
        _aes.Key = key.ToArray();
        _aes.Mode = CipherMode.ECB;
        _aes.Padding = PaddingMode.None;
        iv.CopyTo(_counter);
    }

    public void Transform(ReadOnlySpan<byte> input, Span<byte> output)
    {
        if (output.Length < input.Length)
        {
            throw new ArgumentException("Output buffer too small.");
        }

        var i = 0;
        while (i < input.Length)
        {
            if (_keystreamPos == _keystreamAvailable)
            {
                Refill(Math.Min(ChunkBlocks, (input.Length - i + Block - 1) / Block));
            }

            var n = Math.Min(input.Length - i, _keystreamAvailable - _keystreamPos);
            for (var j = 0; j < n; j++)
            {
                output[i + j] = (byte)(input[i + j] ^ _keystream[_keystreamPos + j]);
            }

            i += n;
            _keystreamPos += n;
        }
    }

    public byte[] Transform(ReadOnlySpan<byte> input)
    {
        var output = new byte[input.Length];
        Transform(input, output);
        return output;
    }

    /// <summary>Advances the keystream by <paramref name="count"/> bytes without producing output.</summary>
    public void Skip(int count)
    {
        Span<byte> scratch = stackalloc byte[256];
        while (count > 0)
        {
            var n = Math.Min(count, scratch.Length);
            Transform(scratch[..n], scratch[..n]);
            count -= n;
        }
    }

    private void Refill(int blocks)
    {
        for (var b = 0; b < blocks; b++)
        {
            _counter.CopyTo(_counterChunk, b * Block);
            IncrementCounter();
        }

        _aes.EncryptEcb(_counterChunk.AsSpan(0, blocks * Block), _keystream.AsSpan(0, blocks * Block), PaddingMode.None);
        _keystreamAvailable = blocks * Block;
        _keystreamPos = 0;
    }

    private void IncrementCounter()
    {
        for (var i = Block - 1; i >= 0; i--)
        {
            if (++_counter[i] != 0)
            {
                break;
            }
        }
    }

    public void Dispose() => _aes.Dispose();
}
