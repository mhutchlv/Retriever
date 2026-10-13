using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

namespace AirPlay.Windows.Audio;

/// <summary>
/// Minimal binding to libfdk-aac for AAC-ELD decoding. Windows ships no AAC-ELD decoder, so
/// this is optional: when the DLL is absent the receiver simply plays no audio.
/// </summary>
public sealed unsafe class FdkAacDecoder : IDisposable
{
    private const string LibraryName = "fdk-aac";
    private const int TT_MP4_RAW = 0;
    private const int AAC_DEC_OK = 0;
    private const int AAC_DEC_NOT_ENOUGH_BITS = 0x1002;

    private static readonly object InitLock = new();
    private static bool _resolverInstalled;
    private IntPtr _handle;
    private readonly short[] _pcm = new short[2048 * 8];

    public FdkAacDecoder(byte[] audioSpecificConfig)
    {
        EnsureResolver();
        _handle = aacDecoder_Open(TT_MP4_RAW, 1);
        if (_handle == IntPtr.Zero)
        {
            throw new InvalidOperationException("aacDecoder_Open failed.");
        }

        fixed (byte* conf = audioSpecificConfig)
        {
            var confs = new[] { (IntPtr)conf };
            var lengths = new[] { (uint)audioSpecificConfig.Length };
            var err = aacDecoder_ConfigRaw(_handle, confs, lengths);
            if (err != AAC_DEC_OK)
            {
                throw new InvalidOperationException($"aacDecoder_ConfigRaw failed: 0x{err:X}");
            }
        }
    }

    /// <summary>AudioSpecificConfig for AAC-ELD, 44.1 kHz, stereo, 480 samples per frame (what iOS mirroring sends).</summary>
    public static byte[] EldConfig44100Stereo { get; } = { 0xF8, 0xE8, 0x50, 0x00 };

    /// <summary>AudioSpecificConfig for AAC-LC, 44.1 kHz, stereo.</summary>
    public static byte[] LcConfig44100Stereo { get; } = { 0x12, 0x10 };

    public int SampleRate { get; private set; }
    public int Channels { get; private set; }

    public static bool IsAvailable
    {
        get
        {
            try
            {
                EnsureResolver();
                return Resolve(LibraryName, typeof(FdkAacDecoder).Assembly, null) != IntPtr.Zero;
            }
            catch
            {
                return false;
            }
        }
    }

    /// <summary>Decodes one frame; returns interleaved 16-bit PCM samples (count = frames * channels), or an empty span.</summary>
    public ReadOnlySpan<short> Decode(ReadOnlySpan<byte> frame)
    {
        if (_handle == IntPtr.Zero)
        {
            return ReadOnlySpan<short>.Empty;
        }

        fixed (byte* data = frame)
        {
            var buffers = new[] { (IntPtr)data };
            var sizes = new[] { (uint)frame.Length };
            var valid = (uint)frame.Length;
            var err = aacDecoder_Fill(_handle, buffers, sizes, ref valid);
            if (err != AAC_DEC_OK)
            {
                return ReadOnlySpan<short>.Empty;
            }
        }

        fixed (short* pcm = _pcm)
        {
            var err = aacDecoder_DecodeFrame(_handle, pcm, _pcm.Length, 0);
            if (err == AAC_DEC_NOT_ENOUGH_BITS)
            {
                return ReadOnlySpan<short>.Empty;
            }

            if (err != AAC_DEC_OK)
            {
                return ReadOnlySpan<short>.Empty;
            }
        }

        var info = (CStreamInfoHead*)aacDecoder_GetStreamInfo(_handle);
        if (info == null || info->frameSize <= 0 || info->numChannels <= 0)
        {
            return ReadOnlySpan<short>.Empty;
        }

        SampleRate = info->sampleRate;
        Channels = info->numChannels;
        return _pcm.AsSpan(0, info->frameSize * info->numChannels);
    }

    public void Dispose()
    {
        if (_handle != IntPtr.Zero)
        {
            aacDecoder_Close(_handle);
            _handle = IntPtr.Zero;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CStreamInfoHead
    {
        public int sampleRate;
        public int frameSize;
        public int numChannels;
    }

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr aacDecoder_Open(int transportFormat, uint layers);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    private static extern int aacDecoder_ConfigRaw(IntPtr handle, IntPtr[] config, uint[] lengths);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    private static extern int aacDecoder_Fill(IntPtr handle, IntPtr[] buffers, uint[] sizes, ref uint bytesValid);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    private static extern int aacDecoder_DecodeFrame(IntPtr handle, short* pcm, int pcmSize, uint flags);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr aacDecoder_GetStreamInfo(IntPtr handle);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    private static extern void aacDecoder_Close(IntPtr handle);

    private static void EnsureResolver()
    {
        lock (InitLock)
        {
            if (_resolverInstalled)
            {
                return;
            }

            NativeLibrary.SetDllImportResolver(typeof(FdkAacDecoder).Assembly, Resolve);
            _resolverInstalled = true;
        }
    }

    private static IntPtr Resolve(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (libraryName != LibraryName)
        {
            return IntPtr.Zero;
        }

        var dir = AppContext.BaseDirectory;
        foreach (var name in new[] { "libfdk-aac-2.dll", "fdk-aac.dll", "libfdk-aac.dll", "fdk-aac-2.dll" })
        {
            var path = Path.Combine(dir, name);
            if (File.Exists(path) && NativeLibrary.TryLoad(path, out var handle))
            {
                return handle;
            }

            if (NativeLibrary.TryLoad(name, out handle))
            {
                return handle;
            }
        }

        return IntPtr.Zero;
    }
}
