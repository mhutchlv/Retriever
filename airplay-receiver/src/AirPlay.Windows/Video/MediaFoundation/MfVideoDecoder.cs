using System.Runtime.InteropServices;
using AirPlay.Streams;

namespace AirPlay.Windows.Video.MediaFoundation;

/// <summary>A decoded NV12 picture, valid only for the duration of the callback.</summary>
public readonly unsafe struct Nv12Picture
{
    public Nv12Picture(byte* y, byte* uv, int pitch, int x, int yOffset, int width, int height)
    {
        Y = y;
        Uv = uv;
        Pitch = pitch;
        X = x;
        YOffset = yOffset;
        Width = width;
        Height = height;
    }

    public byte* Y { get; }
    public byte* Uv { get; }
    public int Pitch { get; }

    /// <summary>Left edge of the visible area within the decoded (aligned) frame.</summary>
    public int X { get; }

    /// <summary>Top edge of the visible area within the decoded (aligned) frame.</summary>
    public int YOffset { get; }
    public int Width { get; }
    public int Height { get; }
}

/// <summary>
/// Wraps the Microsoft H.264 (or HEVC) decoder MFT as a synchronous, low-latency decoder that
/// takes Annex B access units and hands back NV12 pictures. The MFT uses DXVA internally when
/// a GPU is available and falls back to a multi-threaded software decoder otherwise.
/// </summary>
public sealed unsafe class MfVideoDecoder : IDisposable
{
    private static readonly object StartupLock = new();
    private static bool _started;

    private readonly IMFTransform _transform;
    private readonly bool _providesSamples;
    private uint _outputBufferSize;
    private uint _outputAlignment;
    private int _frameWidth;
    private int _frameHeight;
    private int _stride;
    private MFVideoArea _aperture;
    private long _frameIndex;
    private bool _disposed;

    public MfVideoDecoder(VideoCodec codec, int width, int height, Log log)
    {
        Log = log;
        EnsureStarted();
        var clsid = codec == VideoCodec.H265 ? Mf.CLSID_CMSHEVCDecoderMFT : Mf.CLSID_CMSH264DecoderMFT;
        var iid = Mf.IID_IMFTransform;
        var hr = Mf.CoCreateInstance(ref clsid, IntPtr.Zero, Mf.CLSCTX_INPROC_SERVER, ref iid, out var ptr);
        if (hr < 0)
        {
            throw new MediaFoundationException(codec == VideoCodec.H265
                ? "Creating the HEVC decoder (install 'HEVC Video Extensions' from the Microsoft Store)"
                : "Creating the H.264 decoder", hr);
        }

        _transform = (IMFTransform)Marshal.GetObjectForIUnknown(ptr);
        Marshal.Release(ptr);
        Codec = codec;

        ConfigureLowLatency();

        // Input type
        Mf.Check(Mf.MFCreateMediaType(out var input), "MFCreateMediaType");
        var major = Mf.MF_MT_MAJOR_TYPE;
        var video = Mf.MFMediaType_Video;
        Mf.Check(input.SetGUID(ref major, ref video), "SetGUID(major)");
        var subtypeKey = Mf.MF_MT_SUBTYPE;
        var subtype = codec == VideoCodec.H265 ? Mf.MFVideoFormat_HEVC : Mf.MFVideoFormat_H264;
        Mf.Check(input.SetGUID(ref subtypeKey, ref subtype), "SetGUID(subtype)");
        var frameSize = Mf.MF_MT_FRAME_SIZE;
        if (width > 0 && height > 0)
        {
            Mf.Check(input.SetUINT64(ref frameSize, Mf.Pack((uint)width, (uint)height)), "SetUINT64(frame size)");
        }

        var interlace = Mf.MF_MT_INTERLACE_MODE;
        input.SetUINT32(ref interlace, Mf.MFVideoInterlace_Progressive);
        var frameRate = Mf.MF_MT_FRAME_RATE;
        input.SetUINT64(ref frameRate, Mf.Pack(60, 1));
        Mf.Check(_transform.SetInputType(0, input, 0), "SetInputType");

        NegotiateOutputType();

        Mf.Check(_transform.GetOutputStreamInfo(0, out var info), "GetOutputStreamInfo");
        _providesSamples = (info.dwFlags & (Mf.MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | Mf.MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
        _outputBufferSize = info.cbSize;
        _outputAlignment = info.cbAlignment;

        _transform.ProcessMessage(Mf.MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, IntPtr.Zero);
        _transform.ProcessMessage(Mf.MFT_MESSAGE_NOTIFY_START_OF_STREAM, IntPtr.Zero);
        log.Info($"Media Foundation {codec} decoder ready ({_frameWidth}x{_frameHeight}, stride {_stride}, visible {_aperture.Width}x{_aperture.Height}, {(_providesSamples ? "MFT-allocated" : "caller-allocated")} output)");
    }

    public VideoCodec Codec { get; }
    public Log Log { get; }

    /// <summary>Visible picture width after cropping.</summary>
    public int Width => _aperture.Width;
    public int Height => _aperture.Height;

    /// <summary>Called once per decoded picture, on the thread that called <see cref="Decode"/>.</summary>
    public Action<Nv12Picture>? PictureDecoded { get; set; }

    private static void EnsureStarted()
    {
        lock (StartupLock)
        {
            if (!_started)
            {
                Mf.Check(Mf.MFStartup(Mf.MF_VERSION, Mf.MFSTARTUP_FULL), "MFStartup");
                _started = true;
            }
        }
    }

    private void ConfigureLowLatency()
    {
        // Both knobs exist because different Windows builds honour different ones. Failures are harmless.
        if (_transform.GetAttributes(out var attributes) >= 0 && attributes != null)
        {
            var lowLatency = Mf.MF_LOW_LATENCY;
            attributes.SetUINT32(ref lowLatency, 1);
        }

        if (_transform is ICodecAPI codecApi)
        {
            var key = Mf.CODECAPI_AVLowLatencyMode;
            var value = Variant.Bool(true);
            var hr = codecApi.SetValue(ref key, ref value);
            if (hr < 0)
            {
                Log.Debug($"CODECAPI_AVLowLatencyMode not accepted (0x{hr:X8}).");
            }
        }
    }

    private void NegotiateOutputType()
    {
        var subtypeKey = Mf.MF_MT_SUBTYPE;
        for (uint i = 0; ; i++)
        {
            var hr = _transform.GetOutputAvailableType(0, i, out var type);
            if (hr < 0 || type == null)
            {
                throw new MediaFoundationException("No NV12 output type offered by the decoder", hr);
            }

            if (type.GetGUID(ref subtypeKey, out var subtype) >= 0 && subtype == Mf.MFVideoFormat_NV12)
            {
                Mf.Check(_transform.SetOutputType(0, type, 0), "SetOutputType(NV12)");
                break;
            }
        }

        ReadOutputFormat();
    }

    private void ReadOutputFormat()
    {
        Mf.Check(_transform.GetOutputCurrentType(0, out var type), "GetOutputCurrentType");
        var frameSizeKey = Mf.MF_MT_FRAME_SIZE;
        Mf.Check(type.GetUINT64(ref frameSizeKey, out var packed), "GetUINT64(frame size)");
        _frameWidth = (int)(packed >> 32);
        _frameHeight = (int)(packed & 0xFFFFFFFF);

        var strideKey = Mf.MF_MT_DEFAULT_STRIDE;
        _stride = type.GetUINT32(ref strideKey, out var stride) >= 0 && stride != 0 ? (int)stride : _frameWidth;

        var apertureKey = Mf.MF_MT_MINIMUM_DISPLAY_APERTURE;
        var size = (uint)sizeof(MFVideoArea);
        var buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            if (type.GetBlob(ref apertureKey, buffer, size, out var written) >= 0 && written == size)
            {
                _aperture = Marshal.PtrToStructure<MFVideoArea>(buffer);
            }
            else
            {
                _aperture = new MFVideoArea { Width = _frameWidth, Height = _frameHeight };
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        if (_aperture.Width <= 0 || _aperture.Height <= 0 || _aperture.Width > _frameWidth || _aperture.Height > _frameHeight)
        {
            _aperture = new MFVideoArea { Width = _frameWidth, Height = _frameHeight };
        }
    }

    /// <summary>Feeds one Annex B access unit and delivers any pictures that become available.</summary>
    public void Decode(ReadOnlySpan<byte> accessUnit)
    {
        if (_disposed)
        {
            return;
        }

        Mf.Check(Mf.MFCreateMemoryBuffer(accessUnit.Length, out var buffer), "MFCreateMemoryBuffer");
        try
        {
            Mf.Check(buffer.Lock(out var ptr, out _, out _), "IMFMediaBuffer.Lock");
            try
            {
                accessUnit.CopyTo(new Span<byte>((void*)ptr, accessUnit.Length));
            }
            finally
            {
                buffer.Unlock();
            }

            Mf.Check(buffer.SetCurrentLength((uint)accessUnit.Length), "SetCurrentLength");
            Mf.Check(Mf.MFCreateSample(out var sample), "MFCreateSample");
            try
            {
                Mf.Check(sample.AddBuffer(buffer), "AddBuffer");
                sample.SetSampleTime(_frameIndex * 166667);
                sample.SetSampleDuration(166667);
                _frameIndex++;

                var hr = _transform.ProcessInput(0, sample, 0);
                if (hr == Mf.MF_E_NOTACCEPTING)
                {
                    DrainOutput();
                    hr = _transform.ProcessInput(0, sample, 0);
                }

                Mf.Check(hr, "ProcessInput");
            }
            finally
            {
                Marshal.ReleaseComObject(sample);
            }
        }
        finally
        {
            Marshal.ReleaseComObject(buffer);
        }

        DrainOutput();
    }

    /// <summary>Flushes the decoder (e.g. after the stream was paused and resumed).</summary>
    public void Flush()
    {
        if (!_disposed)
        {
            _transform.ProcessMessage(Mf.MFT_MESSAGE_COMMAND_FLUSH, IntPtr.Zero);
        }
    }

    private void DrainOutput()
    {
        var buffers = new MFT_OUTPUT_DATA_BUFFER[1];
        while (true)
        {
            IMFSample? ourSample = null;
            if (!_providesSamples)
            {
                ourSample = CreateOutputSample();
                buffers[0].pSample = Marshal.GetComInterfaceForObject(ourSample, typeof(IMFSample));
            }
            else
            {
                buffers[0].pSample = IntPtr.Zero;
            }

            buffers[0].dwStreamID = 0;
            buffers[0].dwStatus = 0;
            buffers[0].pEvents = IntPtr.Zero;

            var hr = _transform.ProcessOutput(0, 1, buffers, out _);
            if (buffers[0].pEvents != IntPtr.Zero)
            {
                Marshal.Release(buffers[0].pEvents);
                buffers[0].pEvents = IntPtr.Zero;
            }

            try
            {
                if (hr == Mf.MF_E_TRANSFORM_NEED_MORE_INPUT)
                {
                    return;
                }

                if (hr == Mf.MF_E_TRANSFORM_STREAM_CHANGE)
                {
                    NegotiateOutputType();
                    Mf.Check(_transform.GetOutputStreamInfo(0, out var info), "GetOutputStreamInfo");
                    _outputBufferSize = info.cbSize;
                    _outputAlignment = info.cbAlignment;
                    Log.Info($"Decoder output changed: {_frameWidth}x{_frameHeight}, visible {_aperture.Width}x{_aperture.Height}");
                    continue;
                }

                if (hr < 0)
                {
                    Log.Warn($"ProcessOutput failed: 0x{hr:X8}");
                    return;
                }

                var producedPtr = buffers[0].pSample;
                if (producedPtr == IntPtr.Zero)
                {
                    continue;
                }

                var produced = ourSample ?? (IMFSample)Marshal.GetObjectForIUnknown(producedPtr);
                try
                {
                    Deliver(produced);
                }
                finally
                {
                    if (ourSample == null)
                    {
                        Marshal.ReleaseComObject(produced);
                    }
                }
            }
            finally
            {
                if (!_providesSamples && buffers[0].pSample != IntPtr.Zero)
                {
                    Marshal.Release(buffers[0].pSample); // the reference from GetComInterfaceForObject
                }

                if (_providesSamples && buffers[0].pSample != IntPtr.Zero)
                {
                    Marshal.Release(buffers[0].pSample); // the MFT's reference handed to us
                }

                buffers[0].pSample = IntPtr.Zero;
                if (ourSample != null)
                {
                    Marshal.ReleaseComObject(ourSample);
                }
            }
        }
    }

    private IMFSample CreateOutputSample()
    {
        var size = (int)Math.Max(_outputBufferSize, (uint)(_stride * _frameHeight * 3 / 2));
        var alignment = (int)Math.Max(_outputAlignment, 16u);
        Mf.Check(Mf.MFCreateAlignedMemoryBuffer(size, alignment - 1, out var buffer), "MFCreateAlignedMemoryBuffer");
        try
        {
            Mf.Check(Mf.MFCreateSample(out var sample), "MFCreateSample");
            Mf.Check(sample.AddBuffer(buffer), "AddBuffer");
            return sample;
        }
        finally
        {
            Marshal.ReleaseComObject(buffer);
        }
    }

    private void Deliver(IMFSample sample)
    {
        var handler = PictureDecoded;
        if (handler == null)
        {
            return;
        }

        Mf.Check(sample.ConvertToContiguousBuffer(out var buffer), "ConvertToContiguousBuffer");
        try
        {
            if (buffer is IMF2DBuffer twoD && twoD.Lock2D(out var scanline0, out var pitch) >= 0)
            {
                try
                {
                    var y = (byte*)scanline0;
                    var uv = y + (long)pitch * _frameHeight;
                    handler(new Nv12Picture(y, uv, pitch, _aperture.OffsetXValue, _aperture.OffsetYValue, _aperture.Width, _aperture.Height));
                }
                finally
                {
                    twoD.Unlock2D();
                }

                return;
            }

            Mf.Check(buffer.Lock(out var data, out _, out var length), "IMFMediaBuffer.Lock");
            try
            {
                if (length < (uint)(_stride * _frameHeight * 3 / 2))
                {
                    Log.Warn($"Decoded buffer too small ({length} bytes for {_stride}x{_frameHeight} NV12).");
                    return;
                }

                var y = (byte*)data;
                var uv = y + (long)_stride * _frameHeight;
                handler(new Nv12Picture(y, uv, _stride, _aperture.OffsetXValue, _aperture.OffsetYValue, _aperture.Width, _aperture.Height));
            }
            finally
            {
                buffer.Unlock();
            }
        }
        finally
        {
            Marshal.ReleaseComObject(buffer);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        try
        {
            _transform.ProcessMessage(Mf.MFT_MESSAGE_NOTIFY_END_OF_STREAM, IntPtr.Zero);
            _transform.ProcessMessage(Mf.MFT_MESSAGE_NOTIFY_END_STREAMING, IntPtr.Zero);
        }
        catch
        {
        }

        Marshal.FinalReleaseComObject(_transform);
    }
}
