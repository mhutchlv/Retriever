using AirPlay.Streams;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace AirPlay.Windows.Audio;

/// <summary>Decodes AAC-ELD audio from the mirroring session (when fdk-aac is available) and plays it through WASAPI.</summary>
public sealed class AudioPipeline : IDisposable
{
    private readonly Log _log;
    private readonly object _lock = new();
    private FdkAacDecoder? _decoder;
    private WasapiOut? _output;
    private BufferedWaveProvider? _buffer;
    private AudioStreamInfo? _info;
    private float _gain = 1f;
    private bool _unsupportedReported;

    public AudioPipeline(Log log)
    {
        _log = log;
    }

    public bool Enabled { get; set; } = true;

    /// <summary>Why audio is not playing, or null when it is.</summary>
    public string? Status { get; private set; } = "no audio stream";

    public void SetVolumeDb(double db)
    {
        // AirPlay sends -30..0 dB, and -144 for mute.
        _gain = db <= -144 ? 0f : (float)Math.Pow(10, Math.Clamp(db, -30, 0) / 20);
    }

    public void Start(AudioStreamInfo info)
    {
        lock (_lock)
        {
            StopLocked();
            _info = info;
            if (!Enabled)
            {
                Status = "audio disabled";
                return;
            }

            if (info.Codec != AudioCodec.AacEld && info.Codec != AudioCodec.AacLc)
            {
                Status = $"{info.Codec} audio is not supported";
                if (!_unsupportedReported)
                {
                    _log.Warn($"Audio codec {info.Codec} is not supported by this receiver (only AAC via fdk-aac).");
                    _unsupportedReported = true;
                }

                return;
            }

            if (!FdkAacDecoder.IsAvailable)
            {
                Status = "libfdk-aac-2.dll not found (audio unavailable)";
                _log.Warn("Audio: libfdk-aac-2.dll not found next to the executable; mirrored audio will not play. See native/README.md.");
                return;
            }

            try
            {
                _decoder = new FdkAacDecoder(info.Codec == AudioCodec.AacEld ? FdkAacDecoder.EldConfig44100Stereo : FdkAacDecoder.LcConfig44100Stereo);
                var format = new WaveFormat(info.SampleRate, 16, info.Channels);
                _buffer = new BufferedWaveProvider(format)
                {
                    BufferDuration = TimeSpan.FromSeconds(2),
                    DiscardOnBufferOverflow = true,
                };
                _output = new WasapiOut(AudioClientShareMode.Shared, 60);
                _output.Init(_buffer);
                _output.Play();
                Status = null;
                _log.Info($"Audio output started ({info.Codec}, {info.SampleRate} Hz, {info.Channels} ch)");
            }
            catch (Exception ex)
            {
                Status = "audio output failed: " + ex.Message;
                _log.Error($"Audio output failed: {ex}");
                StopLocked();
            }
        }
    }

    public void Push(AudioFrame frame)
    {
        lock (_lock)
        {
            if (_decoder == null || _buffer == null)
            {
                return;
            }

            var pcm = _decoder.Decode(frame.Data);
            if (pcm.IsEmpty)
            {
                return;
            }

            var bytes = new byte[pcm.Length * 2];
            var gain = _gain;
            for (var i = 0; i < pcm.Length; i++)
            {
                var sample = gain >= 0.999f ? pcm[i] : (short)Math.Clamp((int)(pcm[i] * gain), short.MinValue, short.MaxValue);
                bytes[i * 2] = (byte)sample;
                bytes[i * 2 + 1] = (byte)(sample >> 8);
            }

            _buffer.AddSamples(bytes, 0, bytes.Length);
        }
    }

    public void Stop()
    {
        lock (_lock)
        {
            StopLocked();
            Status = "no audio stream";
        }
    }

    private void StopLocked()
    {
        try
        {
            _output?.Stop();
            _output?.Dispose();
        }
        catch
        {
        }

        _output = null;
        _buffer = null;
        _decoder?.Dispose();
        _decoder = null;
    }

    public void Dispose() => Stop();
}
