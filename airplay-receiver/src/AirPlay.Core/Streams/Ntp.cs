using System.Diagnostics;

namespace AirPlay.Streams;

/// <summary>Helpers for the 64-bit NTP (Q32.32) timestamps used throughout the protocol.</summary>
public static class Ntp
{
    public const ulong SecondsFrom1900To1970 = 2208988800UL;
    private static readonly DateTime Epoch1970 = new(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    private static readonly long StartTicks = Stopwatch.GetTimestamp();
    private static readonly double StartUnixSeconds = (DateTime.UtcNow - Epoch1970).TotalSeconds;

    /// <summary>Monotonic local wall-clock in NTP Q32.32 (seconds since 1900).</summary>
    public static ulong LocalNow()
    {
        var elapsed = (Stopwatch.GetTimestamp() - StartTicks) / (double)Stopwatch.Frequency;
        return FromSeconds(StartUnixSeconds + elapsed + SecondsFrom1900To1970);
    }

    public static ulong FromSeconds(double seconds)
    {
        var whole = Math.Floor(seconds);
        var frac = seconds - whole;
        return ((ulong)whole << 32) | (ulong)(frac * 4294967296.0);
    }

    public static double ToSeconds(ulong ntp) => (ntp >> 32) + (ntp & 0xFFFFFFFFUL) / 4294967296.0;

    public static TimeSpan ToTimeSpan(ulong ntp) => TimeSpan.FromSeconds(ToSeconds(ntp));

    public static ulong AddSeconds(ulong ntp, double seconds)
    {
        var total = ToSeconds(ntp) + seconds;
        return total <= 0 ? 0 : FromSeconds(total);
    }
}
