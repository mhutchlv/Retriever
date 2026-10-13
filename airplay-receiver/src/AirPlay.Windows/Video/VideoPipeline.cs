using System.Collections.Concurrent;
using System.IO;
using AirPlay.Streams;
using AirPlay.Windows.Video.MediaFoundation;

namespace AirPlay.Windows.Video;

/// <summary>A finished BGRA frame handed from the decode thread to the UI.</summary>
public sealed class BgraFrame
{
    public BgraFrame(int width, int height)
    {
        Width = width;
        Height = height;
        Stride = width * 4;
        Pixels = new byte[Stride * height];
    }

    public int Width { get; }
    public int Height { get; }
    public int Stride { get; }
    public byte[] Pixels { get; }
}

/// <summary>
/// Owns the decode thread: queues incoming access units, decodes them with Media Foundation,
/// converts to BGRA and publishes the newest frame. When the UI falls behind, older frames
/// are dropped so latency never accumulates.
/// </summary>
public sealed class VideoPipeline : IDisposable
{
    private readonly Log _log;
    private readonly BlockingCollection<VideoFrame> _queue = new(new ConcurrentQueue<VideoFrame>(), 8);
    private readonly Thread _thread;
    private readonly object _frameLock = new();
    private MfVideoDecoder? _decoder;
    private VideoCodecData? _codecData;
    private BgraFrame? _spare;
    private BgraFrame? _latest;
    private bool _needKeyframe = true;
    private volatile bool _running = true;
    private FileStream? _recording;
    private readonly object _recordLock = new();
    private long _decodedFrames;
    private long _droppedFrames;
    private DateTime _fpsWindowStart = DateTime.UtcNow;
    private int _fpsWindowFrames;

    public VideoPipeline(Log log)
    {
        _log = log;
        _thread = new Thread(Run) { IsBackground = true, Name = "airplay-decode" };
        _thread.Start();
    }

    /// <summary>Raised on the decode thread when a new frame is ready; the UI should schedule a repaint.</summary>
    public event Action? FrameReady;

    /// <summary>Raised on the decode thread when decoding cannot proceed.</summary>
    public event Action<string>? DecodeError;

    public double Fps { get; private set; }
    public long DecodedFrames => _decodedFrames;
    public long DroppedFrames => _droppedFrames;
    public bool IsRecording => _recording != null;

    public void SetCodecData(VideoCodecData data)
    {
        _codecData = data;
        _needKeyframe = true;
        // The decoder is re-created lazily on the decode thread when the next frame arrives.
        Enqueue(new VideoFrame(Array.Empty<byte>(), 0, 0, false, true, data.Codec));
    }

    public void Enqueue(VideoFrame frame)
    {
        if (!_running)
        {
            return;
        }

        if (!_queue.TryAdd(frame))
        {
            // Backlog: drop the oldest, keep the newest; the decoder resyncs at the next keyframe.
            if (_queue.TryTake(out _))
            {
                Interlocked.Increment(ref _droppedFrames);
                _needKeyframe = true;
            }

            _queue.TryAdd(frame);
        }
    }

    public void Reset()
    {
        while (_queue.TryTake(out _))
        {
        }

        _needKeyframe = true;
        lock (_frameLock)
        {
            _latest = null;
        }
    }

    /// <summary>Takes the newest frame for display. The caller must return it with <see cref="Return"/>.</summary>
    public BgraFrame? Take()
    {
        lock (_frameLock)
        {
            var f = _latest;
            _latest = null;
            return f;
        }
    }

    public void Return(BgraFrame frame)
    {
        lock (_frameLock)
        {
            _spare ??= frame;
        }
    }

    public void StartRecording(string path)
    {
        lock (_recordLock)
        {
            _recording?.Dispose();
            _recording = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 16);
            _needKeyframe = true; // the file must start with parameter sets + IDR
        }
    }

    public void StopRecording()
    {
        lock (_recordLock)
        {
            _recording?.Dispose();
            _recording = null;
        }
    }

    private void Run()
    {
        while (_running)
        {
            VideoFrame frame;
            try
            {
                frame = _queue.Take();
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (InvalidOperationException)
            {
                return;
            }

            try
            {
                Process(frame);
            }
            catch (Exception ex)
            {
                _log.Error($"Decoding failed: {ex.Message}");
                DecodeError?.Invoke(ex.Message);
                _decoder?.Dispose();
                _decoder = null;
                _needKeyframe = true;
            }
        }
    }

    private void Process(VideoFrame frame)
    {
        var codecData = _codecData;
        if (frame.Length == 0)
        {
            // Codec change marker: rebuild the decoder with the new parameters.
            if (codecData != null && (_decoder == null || _decoder.Codec != codecData.Codec))
            {
                _decoder?.Dispose();
                _decoder = null;
            }

            return;
        }

        if (codecData == null)
        {
            return;
        }

        if (_decoder == null)
        {
            _decoder = new MfVideoDecoder(codecData.Codec, codecData.Width, codecData.Height, _log);
            _decoder.PictureDecoded = OnPicture;
            _needKeyframe = true;
        }

        if (_needKeyframe)
        {
            if (!frame.IsKeyframe)
            {
                return;
            }

            _needKeyframe = false;
            _decoder.Flush();
            if (!frame.IncludesParameterSets)
            {
                _decoder.Decode(codecData.ParameterSets);
            }
        }

        lock (_recordLock)
        {
            if (_recording != null)
            {
                if (frame.IsKeyframe && !frame.IncludesParameterSets)
                {
                    _recording.Write(codecData.ParameterSets);
                }

                _recording.Write(frame.Span);
            }
        }

        _decoder.Decode(frame.Span);
    }

    private unsafe void OnPicture(Nv12Picture picture)
    {
        BgraFrame target;
        lock (_frameLock)
        {
            target = _spare != null && _spare.Width == picture.Width && _spare.Height == picture.Height ? _spare : new BgraFrame(picture.Width, picture.Height);
            _spare = null;
        }

        fixed (byte* dst = target.Pixels)
        {
            Nv12Converter.Convert(picture, dst, target.Stride);
        }

        lock (_frameLock)
        {
            if (_latest != null)
            {
                Interlocked.Increment(ref _droppedFrames);
                _spare ??= _latest;
            }

            _latest = target;
        }

        Interlocked.Increment(ref _decodedFrames);
        _fpsWindowFrames++;
        var elapsed = DateTime.UtcNow - _fpsWindowStart;
        if (elapsed.TotalSeconds >= 1)
        {
            Fps = _fpsWindowFrames / elapsed.TotalSeconds;
            _fpsWindowFrames = 0;
            _fpsWindowStart = DateTime.UtcNow;
        }

        FrameReady?.Invoke();
    }

    public void Dispose()
    {
        _running = false;
        _queue.CompleteAdding();
        if (!_thread.Join(2000))
        {
            _log.Warn("Decode thread did not stop in time.");
        }

        _decoder?.Dispose();
        _decoder = null;
        StopRecording();
        _queue.Dispose();
    }
}
