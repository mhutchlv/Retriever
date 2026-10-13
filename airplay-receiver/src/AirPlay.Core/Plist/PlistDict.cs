namespace AirPlay.Plist;

/// <summary>
/// Ordered string-keyed dictionary used as the plist object model for dictionaries.
/// Values are: PlistDict, List&lt;object?&gt;, string, long, double, bool, byte[], DateTime, PlistUid or null.
/// </summary>
public sealed class PlistDict : Dictionary<string, object?>
{
    public PlistDict() : base(StringComparer.Ordinal)
    {
    }

    public PlistDict(IEnumerable<KeyValuePair<string, object?>> items) : this()
    {
        foreach (var kv in items)
        {
            this[kv.Key] = kv.Value;
        }
    }

    public string? GetString(string key) => TryGetValue(key, out var v) ? v as string : null;

    public byte[]? GetData(string key) => TryGetValue(key, out var v) ? v as byte[] : null;

    public PlistDict? GetDict(string key) => TryGetValue(key, out var v) ? v as PlistDict : null;

    public List<object?>? GetArray(string key) => TryGetValue(key, out var v) ? v as List<object?> : null;

    public bool? GetBool(string key) => TryGetValue(key, out var v) && v is bool b ? b : null;

    public long? GetInt(string key)
    {
        if (!TryGetValue(key, out var v))
        {
            return null;
        }

        return v switch
        {
            long l => l,
            int i => i,
            ulong ul => unchecked((long)ul),
            double d => (long)d,
            _ => null,
        };
    }

    public double? GetReal(string key)
    {
        if (!TryGetValue(key, out var v))
        {
            return null;
        }

        return v switch
        {
            double d => d,
            long l => l,
            int i => i,
            _ => null,
        };
    }
}

/// <summary>A CF$UID value (only kept so round-trips do not lose it).</summary>
public readonly record struct PlistUid(ulong Value);
