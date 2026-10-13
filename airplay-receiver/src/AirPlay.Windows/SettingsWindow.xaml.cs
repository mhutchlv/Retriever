using System.Windows;
using AirPlay.Windows.Platform;
using AirPlay.Windows.Settings;

namespace AirPlay.Windows;

public partial class SettingsWindow : Window
{
    private readonly AppSettings _settings;

    public SettingsWindow(AppSettings settings)
    {
        InitializeComponent();
        _settings = settings;
        NameBox.Text = settings.ReceiverName;
        PasswordBox.Text = settings.Password ?? "";
        AspectBox.SelectedIndex = (int)settings.AspectMode;
        AlwaysOnTopBox.IsChecked = settings.AlwaysOnTop;
        StartWithWindowsBox.IsChecked = settings.StartWithWindows;
        MinimizeToTrayBox.IsChecked = settings.MinimizeToTray;
        StartMinimizedBox.IsChecked = settings.StartMinimized;
        EnableAudioBox.IsChecked = settings.EnableAudio;
        HevcBox.IsChecked = settings.SupportHevc;
        TakeoverBox.IsChecked = settings.AllowTakeover;
        VerboseBox.IsChecked = settings.VerboseLogging;
        RefreshFirewallStatus();
    }

    public AppSettings Result { get; private set; } = new();

    private void RefreshFirewallStatus()
    {
        var exists = FirewallHelper.RuleExists();
        FirewallStatus.Text = exists ? "rule present" : "no rule (Windows will prompt on first use)";
        FirewallButton.Content = exists ? "Re-create firewall rule..." : "Add firewall rule...";
    }

    private void OnFirewallClick(object sender, RoutedEventArgs e)
    {
        if (!FirewallHelper.AddRule())
        {
            MessageBox.Show(this, "The firewall rule was not added (the elevation prompt was declined or netsh failed).", "Windows Firewall", MessageBoxButton.OK, MessageBoxImage.Warning);
        }

        RefreshFirewallStatus();
    }

    private void OnSaveClick(object sender, RoutedEventArgs e)
    {
        var s = _settings.Clone();
        s.ReceiverName = string.IsNullOrWhiteSpace(NameBox.Text) ? Environment.MachineName : NameBox.Text.Trim();
        s.Password = string.IsNullOrWhiteSpace(PasswordBox.Text) ? null : PasswordBox.Text;
        s.AspectMode = (AspectMode)Math.Max(0, AspectBox.SelectedIndex);
        s.AlwaysOnTop = AlwaysOnTopBox.IsChecked == true;
        s.StartWithWindows = StartWithWindowsBox.IsChecked == true;
        s.MinimizeToTray = MinimizeToTrayBox.IsChecked == true;
        s.StartMinimized = StartMinimizedBox.IsChecked == true;
        s.EnableAudio = EnableAudioBox.IsChecked == true;
        s.SupportHevc = HevcBox.IsChecked == true;
        s.AllowTakeover = TakeoverBox.IsChecked == true;
        s.VerboseLogging = VerboseBox.IsChecked == true;
        Result = s;
        DialogResult = true;
    }
}
