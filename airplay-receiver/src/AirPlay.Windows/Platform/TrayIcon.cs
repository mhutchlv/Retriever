using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace AirPlay.Windows.Platform;

/// <summary>System tray icon with a small context menu. Draws its own icon so no asset file is needed.</summary>
public sealed class TrayIcon : IDisposable
{
    private readonly NotifyIcon _icon;
    private readonly Icon _idle;
    private readonly Icon _active;

    public TrayIcon(string text, Action open, Action settings, Action disconnect, Action exit)
    {
        _idle = DrawIcon(Color.FromArgb(0x4A, 0x90, 0xE2));
        _active = DrawIcon(Color.FromArgb(0x2E, 0xCC, 0x71));
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open", null, (_, _) => open());
        menu.Items.Add("Settings...", null, (_, _) => settings());
        menu.Items.Add("Disconnect device", null, (_, _) => disconnect());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => exit());
        _icon = new NotifyIcon
        {
            Icon = _idle,
            Text = Truncate(text),
            Visible = true,
            ContextMenuStrip = menu,
        };
        _icon.DoubleClick += (_, _) => open();
    }

    public void SetStatus(string text, bool active)
    {
        _icon.Text = Truncate(text);
        _icon.Icon = active ? _active : _idle;
    }

    public void ShowBalloon(string title, string text) => _icon.ShowBalloonTip(3000, title, text, ToolTipIcon.Info);

    private static string Truncate(string s) => s.Length > 63 ? s[..63] : s;

    private static Icon DrawIcon(Color color)
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var brush = new SolidBrush(color);
            g.FillEllipse(brush, 2, 2, 28, 28);
            using var pen = new Pen(Color.White, 3f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            // A small "screen" glyph with a stand
            g.DrawRectangle(pen, 8, 9, 16, 11);
            g.DrawLine(pen, 12, 24, 20, 24);
        }

        var handle = bmp.GetHicon();
        return (Icon)Icon.FromHandle(handle).Clone();
    }

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
        _idle.Dispose();
        _active.Dispose();
    }
}
