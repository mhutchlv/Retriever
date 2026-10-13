using System.Text;

namespace AirPlay;

public static class Hex
{
    public static string ToLower(ReadOnlySpan<byte> bytes) => Convert.ToHexString(bytes).ToLowerInvariant();

    public static string ToUpper(ReadOnlySpan<byte> bytes) => Convert.ToHexString(bytes);

    public static byte[] Parse(string hex) => Convert.FromHexString(hex.Trim());

    /// <summary>Formats a hardware address as "aa:bb:cc:dd:ee:ff" (AirPlay deviceid style).</summary>
    public static string MacColon(ReadOnlySpan<byte> mac)
    {
        var sb = new StringBuilder(mac.Length * 3);
        for (var i = 0; i < mac.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(':');
            }

            sb.Append(mac[i].ToString("x2"));
        }

        return sb.ToString();
    }

    /// <summary>Formats a hardware address as "AABBCCDDEEFF" (RAOP instance-name prefix style).</summary>
    public static string MacPlain(ReadOnlySpan<byte> mac) => Convert.ToHexString(mac);

    public static string Dump(ReadOnlySpan<byte> data, int max = 64)
    {
        var n = Math.Min(max, data.Length);
        var s = ToLower(data[..n]);
        return data.Length > max ? s + $"... ({data.Length} bytes)" : s;
    }
}
