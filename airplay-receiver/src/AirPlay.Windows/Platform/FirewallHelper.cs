using System.Diagnostics;

namespace AirPlay.Windows.Platform;

/// <summary>Adds or removes the Windows Defender Firewall rule that lets iPhones reach the receiver.</summary>
public static class FirewallHelper
{
    public const string RuleName = "AirPlay Receiver";

    public static string ExecutablePath => Environment.ProcessPath ?? System.Reflection.Assembly.GetEntryAssembly()!.Location;

    /// <summary>True when a rule with our name exists (no elevation needed to check).</summary>
    public static bool RuleExists()
    {
        try
        {
            var psi = new ProcessStartInfo("netsh", $"advfirewall firewall show rule name=\"{RuleName}\"")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true,
            };
            using var p = Process.Start(psi)!;
            var output = p.StandardOutput.ReadToEnd();
            p.WaitForExit(5000);
            return p.ExitCode == 0 && output.Contains("Rule Name", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Adds an inbound allow rule for this executable on private and domain networks. Prompts for elevation.</summary>
    public static bool AddRule()
    {
        var exe = ExecutablePath;
        var script = $"advfirewall firewall delete rule name=\"{RuleName}\" & netsh advfirewall firewall add rule name=\"{RuleName}\" dir=in action=allow program=\"{exe}\" enable=yes profile=private,domain protocol=any description=\"Allows iPhones and iPads to connect to the AirPlay receiver (mDNS discovery, RTSP control, video and audio streams).\"";
        return RunElevated("netsh", script);
    }

    public static bool RemoveRule() => RunElevated("netsh", $"advfirewall firewall delete rule name=\"{RuleName}\"");

    private static bool RunElevated(string file, string arguments)
    {
        try
        {
            // cmd /c lets us chain the delete and add in one elevation prompt.
            var psi = new ProcessStartInfo("cmd.exe", $"/c {file} {arguments}")
            {
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            using var p = Process.Start(psi);
            p?.WaitForExit(30000);
            return p?.ExitCode == 0;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false; // user declined the UAC prompt
        }
    }
}
