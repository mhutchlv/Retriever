using System.Security.Cryptography;
using System.Text;

namespace AirPlay.Pairing;

/// <summary>RFC 2617 MD5 Digest authentication, the scheme iOS uses when a receiver asks for an AirPlay password.</summary>
public static class DigestAuth
{
    public const string Realm = "raop";

    public static string NewNonce()
    {
        Span<byte> bytes = stackalloc byte[16];
        RandomNumberGenerator.Fill(bytes);
        return Hex.ToLower(bytes);
    }

    public static string Challenge(string nonce) => $"Digest realm=\"{Realm}\", nonce=\"{nonce}\"";

    /// <summary>Verifies an Authorization header against the password; the nonce must match the one we issued.</summary>
    public static bool Verify(string method, string authorization, string password, string expectedNonce)
    {
        var fields = ParseFields(authorization);
        if (!fields.TryGetValue("username", out var username) || !fields.TryGetValue("realm", out var realm)
            || !fields.TryGetValue("nonce", out var nonce) || !fields.TryGetValue("uri", out var uri)
            || !fields.TryGetValue("response", out var response))
        {
            return false;
        }

        if (!string.Equals(nonce, expectedNonce, StringComparison.Ordinal))
        {
            return false;
        }

        var ha1 = Md5($"{username}:{realm}:{password}");
        var ha2 = Md5($"{method}:{uri}");
        string expected;
        if (fields.TryGetValue("qop", out var qop) && !string.IsNullOrEmpty(qop))
        {
            fields.TryGetValue("nc", out var nc);
            fields.TryGetValue("cnonce", out var cnonce);
            expected = Md5($"{ha1}:{nonce}:{nc}:{cnonce}:{qop}:{ha2}");
        }
        else
        {
            expected = Md5($"{ha1}:{nonce}:{ha2}");
        }

        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(response.ToLowerInvariant()));
    }

    /// <summary>Builds a client Authorization header (used by tests and tools).</summary>
    public static string Authorize(string method, string uri, string username, string password, string nonce)
    {
        var ha1 = Md5($"{username}:{Realm}:{password}");
        var ha2 = Md5($"{method}:{uri}");
        var response = Md5($"{ha1}:{nonce}:{ha2}");
        return $"Digest username=\"{username}\", realm=\"{Realm}\", nonce=\"{nonce}\", uri=\"{uri}\", response=\"{response}\"";
    }

    public static string Md5(string s) => Hex.ToLower(MD5.HashData(Encoding.UTF8.GetBytes(s)));

    public static Dictionary<string, string> ParseFields(string header)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var s = header.Trim();
        if (s.StartsWith("Digest", StringComparison.OrdinalIgnoreCase))
        {
            s = s[6..];
        }

        var i = 0;
        while (i < s.Length)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == ',' || s[i] == '\t'))
            {
                i++;
            }

            var eq = s.IndexOf('=', i);
            if (eq < 0)
            {
                break;
            }

            var key = s[i..eq].Trim();
            i = eq + 1;
            string value;
            if (i < s.Length && s[i] == '"')
            {
                var close = s.IndexOf('"', i + 1);
                if (close < 0)
                {
                    break;
                }

                value = s[(i + 1)..close];
                i = close + 1;
            }
            else
            {
                var comma = s.IndexOf(',', i);
                if (comma < 0)
                {
                    comma = s.Length;
                }

                value = s[i..comma].Trim();
                i = comma;
            }

            result[key] = value;
        }

        return result;
    }
}
