using System.ComponentModel;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using AirPlay.Streams;
using AirPlay.Windows.Audio;
using AirPlay.Windows.Platform;
using AirPlay.Windows.Settings;
using AirPlay.Windows.Video;

namespace AirPlay.Windows;

public partial class MainWindow : Window
{
    private readonly VideoPipeline _video;
    private readonly AudioPipeline _audio;
    private readonly DispatcherTimer _statusTimer;
    private readonly TrayIcon _tray;
    private AirPlayReceiver? _receiver;
    private WriteableBitmap? _bitmap;
    private int _repaintScheduled;
    private bool _fullscreen;
    private WindowState _restoreState;
    private WindowStyle _restoreStyle;
    private bool _exiting;
    private ClientInfo? _client;
    private VideoCodecData? _codec;
    private string? _lastError;
    private DateTime _lastFrameAt;

    public MainWindow(bool startMinimized)
    {
        InitializeComponent();
        var settings = App.Settings;
        Width = settings.WindowWidth;
        Height = settings.WindowHeight;
        Topmost = settings.AlwaysOnTop;
        ApplyAspect(settings.AspectMode);

        _video = new VideoPipeline(App.Log);
        _video.FrameReady += OnFrameReady;
        _video.DecodeError += message => Dispatcher.BeginInvoke(() => { _lastError = "decoder: " + message; UpdateStatus(); });
        _audio = new AudioPipeline(App.Log) { Enabled = settings.EnableAudio };

        _tray = new TrayIcon("AirPlay Receiver", ShowFromTray, () => Dispatcher.BeginInvoke(OpenSettings), () => _receiver?.DisconnectClient(), () => Dispatcher.BeginInvoke(ExitApplication));
        _statusTimer = new DispatcherTimer(TimeSpan.FromSeconds(1), DispatcherPriority.Background, (_, _) => UpdateStatus(), Dispatcher);
        _statusTimer.Start();

        App.LogLine += OnLogLine;
        StartReceiver();
        UpdateStatus();
    }

    // ---------------------------------------------------------------- receiver lifecycle

    private void StartReceiver()
    {
        StopReceiver();
        var settings = App.Settings;
        try
        {
            var options = settings.ToReceiverOptions();
            var receiver = new AirPlayReceiver(options, App.Log);
            receiver.ClientConnected += c => Dispatcher.BeginInvoke(() => OnClientConnected(c));
            receiver.ClientDisconnected += (c, why) => Dispatcher.BeginInvoke(() => OnClientDisconnected(c, why));
            receiver.VideoCodecData += d =>
            {
                _codec = d;
                _video.SetCodecData(d);
                Dispatcher.BeginInvoke(UpdateStatus);
            };
            receiver.VideoFrame += f => _video.Enqueue(f);
            receiver.VideoPaused += () => Dispatcher.BeginInvoke(() => SetOverlay("Paused", "The device paused mirroring (screen locked or app in the background)."));
            receiver.VideoResumed += () => Dispatcher.BeginInvoke(() => Overlay.Visibility = Visibility.Collapsed);
            receiver.VideoStopped += () => Dispatcher.BeginInvoke(() => _video.Reset());
            receiver.AudioStarted += info => _audio.Start(info);
            receiver.AudioFrame += frame => _audio.Push(frame);
            receiver.VolumeChanged += db => _audio.SetVolumeDb(db);
            receiver.StreamError += e => Dispatcher.BeginInvoke(() => { _lastError = e; UpdateStatus(); });
            receiver.Start();
            _receiver = receiver;
            _lastError = null;
            SetOverlay("Waiting for a device", $"On the iPhone or iPad, open Control Center, tap Screen Mirroring and choose “{options.Name}”.");
            OverlayHint.Text = FirewallHelper.RuleExists()
                ? ""
                : "If the PC does not appear on the device, allow the app through Windows Firewall when prompted, or add the rule in Settings.";
            _tray.SetStatus($"AirPlay Receiver – {options.Name}", false);
        }
        catch (Exception ex)
        {
            App.Log.Error($"Could not start the receiver: {ex}");
            SetOverlay("Could not start", ex.Message);
            _lastError = ex.Message;
        }
    }

    private void StopReceiver()
    {
        var r = _receiver;
        _receiver = null;
        r?.Dispose();
        _audio.Stop();
        _video.Reset();
    }

    private void OnClientConnected(ClientInfo client)
    {
        _client = client;
        _lastError = null;
        SetOverlay("Connected", $"{client.Name ?? "Device"} is connecting…");
        _tray.SetStatus($"AirPlay Receiver – {client.Name}", true);
        if (App.Settings.MinimizeToTray && !IsVisible)
        {
            _tray.ShowBalloon("AirPlay Receiver", $"{client.Name ?? "A device"} started mirroring.");
        }

        UpdateStatus();
    }

    private void OnClientDisconnected(ClientInfo client, string reason)
    {
        _client = null;
        _codec = null;
        _video.Reset();
        _audio.Stop();
        ClearVideo();
        SetOverlay("Waiting for a device", $"{client.Name ?? "The device"} disconnected ({reason}).\nOpen Control Center → Screen Mirroring to connect again.");
        _tray.SetStatus($"AirPlay Receiver – {App.Settings.ReceiverName}", false);
        if (RecordItem.IsChecked)
        {
            _video.StopRecording();
            RecordItem.IsChecked = false;
        }

        UpdateStatus();
    }

    // ---------------------------------------------------------------- video presentation

    private void OnFrameReady()
    {
        if (Interlocked.Exchange(ref _repaintScheduled, 1) == 0)
        {
            Dispatcher.BeginInvoke(Repaint, DispatcherPriority.Render);
        }
    }

    private void Repaint()
    {
        _repaintScheduled = 0;
        var frame = _video.Take();
        if (frame == null)
        {
            return;
        }

        try
        {
            if (_bitmap == null || _bitmap.PixelWidth != frame.Width || _bitmap.PixelHeight != frame.Height)
            {
                _bitmap = new WriteableBitmap(frame.Width, frame.Height, 96, 96, PixelFormats.Bgra32, null);
                VideoImage.Source = _bitmap;
                App.Log.Info($"Presenting {frame.Width}x{frame.Height}");
            }

            _bitmap.Lock();
            try
            {
                unsafe
                {
                    fixed (byte* src = frame.Pixels)
                    {
                        Buffer.MemoryCopy(src, (void*)_bitmap.BackBuffer, (long)_bitmap.BackBufferStride * frame.Height, (long)frame.Stride * frame.Height);
                    }
                }

                _bitmap.AddDirtyRect(new Int32Rect(0, 0, frame.Width, frame.Height));
            }
            finally
            {
                _bitmap.Unlock();
            }

            _lastFrameAt = DateTime.UtcNow;
            if (Overlay.Visibility == Visibility.Visible)
            {
                Overlay.Visibility = Visibility.Collapsed;
            }
        }
        finally
        {
            _video.Return(frame);
        }
    }

    private void ClearVideo()
    {
        _bitmap = null;
        VideoImage.Source = null;
    }

    private void SetOverlay(string title, string text)
    {
        OverlayTitle.Text = title;
        OverlayText.Text = text;
        Overlay.Visibility = Visibility.Visible;
    }

    private void UpdateStatus()
    {
        var parts = new List<string>();
        if (_client != null)
        {
            parts.Add(_client.Name ?? "device");
            if (_codec != null)
            {
                parts.Add($"{_codec.Codec} {_codec.Width}x{_codec.Height}");
            }

            parts.Add($"{_video.Fps:F0} fps");
            var offset = _receiver?.ClientClockOffsetSeconds;
            if (offset != null)
            {
                parts.Add($"clock sync ok");
            }

            var audio = _audio.Status;
            parts.Add(audio == null ? "audio on" : audio);
        }
        else
        {
            parts.Add($"“{App.Settings.ReceiverName}” is discoverable on port {_receiver?.RtspPort ?? App.Settings.RtspPort}");
        }

        if (_lastError != null)
        {
            parts.Add("error: " + _lastError);
        }

        StatusLeft.Text = string.Join("  ·  ", parts);
        StatusRight.Text = _video.IsRecording ? "● REC" : _video.DroppedFrames > 0 ? $"dropped {_video.DroppedFrames}" : "";
        StatusBar.Visibility = _fullscreen ? Visibility.Collapsed : Visibility.Visible;
    }

    private void OnLogLine(LogLevel level, string line)
    {
        if (level >= LogLevel.Warning)
        {
            Dispatcher.BeginInvoke(() =>
            {
                OverlayHint.Text = line.Length > 160 ? line[..160] + "…" : line;
            });
        }
    }

    // ---------------------------------------------------------------- window commands

    private void OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.F11 || (e.Key == Key.Enter && Keyboard.Modifiers == ModifierKeys.Alt))
        {
            ToggleFullscreen();
        }
        else if (e.Key == Key.Escape && _fullscreen)
        {
            ToggleFullscreen();
        }
        else if (e.Key == Key.S && Keyboard.Modifiers == ModifierKeys.Control)
        {
            SaveScreenshot();
        }
        else if (e.Key == Key.T && Keyboard.Modifiers == ModifierKeys.Control)
        {
            ToggleAlwaysOnTop();
        }
        else if (e.Key == Key.R && Keyboard.Modifiers == ModifierKeys.Control)
        {
            ToggleRecording();
        }
        else if (e.Key == Key.OemComma && Keyboard.Modifiers == ModifierKeys.Control)
        {
            OpenSettings();
        }
    }

    private void OnMouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton == MouseButton.Left)
        {
            ToggleFullscreen();
        }
    }

    private void OnToggleFullscreen(object sender, RoutedEventArgs e) => ToggleFullscreen();

    private void ToggleFullscreen()
    {
        if (!_fullscreen)
        {
            _restoreState = WindowState;
            _restoreStyle = WindowStyle;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            WindowState = WindowState.Normal;
            WindowState = WindowState.Maximized;
            _fullscreen = true;
        }
        else
        {
            WindowStyle = _restoreStyle;
            ResizeMode = ResizeMode.CanResize;
            WindowState = _restoreState == WindowState.Maximized ? WindowState.Maximized : WindowState.Normal;
            _fullscreen = false;
        }

        UpdateStatus();
    }

    private void OnToggleAlwaysOnTop(object sender, RoutedEventArgs e) => ToggleAlwaysOnTop();

    private void ToggleAlwaysOnTop()
    {
        Topmost = !Topmost;
        AlwaysOnTopItem.IsChecked = Topmost;
        App.Settings.AlwaysOnTop = Topmost;
        App.Settings.Save();
    }

    private void OnAspectFit(object sender, RoutedEventArgs e) => SetAspect(AspectMode.Fit);
    private void OnAspectFill(object sender, RoutedEventArgs e) => SetAspect(AspectMode.Fill);
    private void OnAspectStretch(object sender, RoutedEventArgs e) => SetAspect(AspectMode.Stretch);

    private void SetAspect(AspectMode mode)
    {
        App.Settings.AspectMode = mode;
        App.Settings.Save();
        ApplyAspect(mode);
    }

    private void ApplyAspect(AspectMode mode)
    {
        VideoImage.Stretch = mode switch
        {
            AspectMode.Fill => Stretch.UniformToFill,
            AspectMode.Stretch => Stretch.Fill,
            _ => Stretch.Uniform,
        };
        AspectFitItem.IsChecked = mode == AspectMode.Fit;
        AspectFillItem.IsChecked = mode == AspectMode.Fill;
        AspectStretchItem.IsChecked = mode == AspectMode.Stretch;
        AlwaysOnTopItem.IsChecked = Topmost;
    }

    private void OnScreenshot(object sender, RoutedEventArgs e) => SaveScreenshot();

    private void SaveScreenshot()
    {
        if (_bitmap == null)
        {
            return;
        }

        var folder = App.Settings.ScreenshotFolder ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "AirPlay Receiver");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, $"AirPlay {DateTime.Now:yyyy-MM-dd HH-mm-ss}.png");
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(_bitmap.Clone()));
        using (var stream = File.Create(path))
        {
            encoder.Save(stream);
        }

        App.Log.Info($"Screenshot saved to {path}");
        OverlayHint.Text = $"Screenshot saved: {path}";
    }

    private void OnToggleRecording(object sender, RoutedEventArgs e) => ToggleRecording();

    private void ToggleRecording()
    {
        if (_video.IsRecording)
        {
            _video.StopRecording();
            RecordItem.IsChecked = false;
        }
        else
        {
            var folder = App.Settings.RecordingFolder ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "AirPlay Receiver");
            Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, $"AirPlay {DateTime.Now:yyyy-MM-dd HH-mm-ss}.h264");
            _video.StartRecording(path);
            RecordItem.IsChecked = true;
            App.Log.Info($"Recording raw H.264 to {path} (play with VLC, or remux: ffmpeg -r 60 -i file.h264 -c copy file.mp4)");
        }

        UpdateStatus();
    }

    private void OnDisconnect(object sender, RoutedEventArgs e) => _receiver?.DisconnectClient();

    private void OnSettings(object sender, RoutedEventArgs e) => OpenSettings();

    private void OpenSettings()
    {
        var dialog = new SettingsWindow(App.Settings) { Owner = IsVisible ? this : null };
        if (dialog.ShowDialog() != true)
        {
            return;
        }

        var old = App.Settings;
        var updated = dialog.Result;
        updated.WindowWidth = old.WindowWidth;
        updated.WindowHeight = old.WindowHeight;
        updated.Save();
        App.ReplaceSettings(updated);

        Topmost = updated.AlwaysOnTop;
        ApplyAspect(updated.AspectMode);
        _audio.Enabled = updated.EnableAudio;
        try
        {
            StartupHelper.SetEnabled(updated.StartWithWindows);
        }
        catch (Exception ex)
        {
            App.Log.Warn($"Could not update the startup entry: {ex.Message}");
        }

        if (updated.VerboseLogging != old.VerboseLogging)
        {
            App.Log.Minimum = updated.VerboseLogging ? LogLevel.Debug : LogLevel.Info;
        }

        var needsRestart = updated.ReceiverName != old.ReceiverName || updated.Password != old.Password || updated.SupportHevc != old.SupportHevc
                           || updated.AllowTakeover != old.AllowTakeover || updated.RtspPort != old.RtspPort || updated.MirrorDataPort != old.MirrorDataPort
                           || updated.AudioDataPort != old.AudioDataPort || updated.AudioControlPort != old.AudioControlPort || updated.TimingPort != old.TimingPort;
        if (needsRestart)
        {
            _client = null;
            ClearVideo();
            StartReceiver();
        }

        UpdateStatus();
    }

    private void OnOpenLogFolder(object sender, RoutedEventArgs e)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer.exe", AppSettings.Directory) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            App.Log.Warn($"Could not open the log folder: {ex.Message}");
        }
    }

    private void OnExit(object sender, RoutedEventArgs e) => ExitApplication();

    private void ExitApplication()
    {
        _exiting = true;
        Close();
    }

    private void ShowFromTray()
    {
        Dispatcher.BeginInvoke(() =>
        {
            Show();
            if (WindowState == WindowState.Minimized)
            {
                WindowState = WindowState.Normal;
            }

            Activate();
        });
    }

    private void OnStateChanged(object sender, EventArgs e)
    {
        if (WindowState == WindowState.Minimized && App.Settings.MinimizeToTray && !_fullscreen)
        {
            Hide();
        }
    }

    private void OnClosing(object sender, CancelEventArgs e)
    {
        if (!_exiting && App.Settings.MinimizeToTray)
        {
            // Closing the window keeps the receiver alive in the tray; Exit is in the menus.
            e.Cancel = true;
            Hide();
            return;
        }

        if (WindowState == WindowState.Normal && !_fullscreen)
        {
            App.Settings.WindowWidth = Width;
            App.Settings.WindowHeight = Height;
            try
            {
                App.Settings.Save();
            }
            catch
            {
            }
        }

        App.LogLine -= OnLogLine;
        _statusTimer.Stop();
        StopReceiver();
        _video.Dispose();
        _audio.Dispose();
        _tray.Dispose();
        Application.Current.Shutdown();
    }
}
