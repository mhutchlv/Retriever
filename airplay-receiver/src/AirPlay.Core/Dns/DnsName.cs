using System.Text;

namespace AirPlay.Dns;

/// <summary>
/// A DNS name as a list of labels. Service-instance labels may contain spaces, dots and UTF-8,
/// which is why names are not handled as dotted strings internally.
/// </summary>
public sealed class DnsName : IEquatable<DnsName>
{
    public DnsName(IReadOnlyList<string> labels)
    {
        Labels = labels;
    }

    public IReadOnlyList<string> Labels { get; }

    /// <summary>Builds a name from a dotted string ("_airplay._tcp.local"). Labels are not unescaped.</summary>
    public static DnsName Parse(string dotted) =>
        new(dotted.TrimEnd('.').Split('.', StringSplitOptions.RemoveEmptyEntries));

    public static DnsName Instance(string instance, DnsName serviceType)
    {
        var labels = new List<string>(serviceType.Labels.Count + 1) { instance };
        labels.AddRange(serviceType.Labels);
        return new DnsName(labels);
    }

    public DnsName Parent() => new(Labels.Skip(1).ToList());

    public bool EndsWith(DnsName suffix)
    {
        if (suffix.Labels.Count > Labels.Count)
        {
            return false;
        }

        var offset = Labels.Count - suffix.Labels.Count;
        for (var i = 0; i < suffix.Labels.Count; i++)
        {
            if (!LabelEquals(Labels[offset + i], suffix.Labels[i]))
            {
                return false;
            }
        }

        return true;
    }

    public static bool LabelEquals(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    public bool Equals(DnsName? other)
    {
        if (other is null || other.Labels.Count != Labels.Count)
        {
            return false;
        }

        for (var i = 0; i < Labels.Count; i++)
        {
            if (!LabelEquals(Labels[i], other.Labels[i]))
            {
                return false;
            }
        }

        return true;
    }

    public override bool Equals(object? obj) => Equals(obj as DnsName);

    public override int GetHashCode()
    {
        var h = new HashCode();
        foreach (var l in Labels)
        {
            h.Add(l.ToLowerInvariant());
        }

        return h.ToHashCode();
    }

    public override string ToString() => string.Join('.', Labels) + ".";

    internal int EncodedLength() => Labels.Sum(l => 1 + Encoding.UTF8.GetByteCount(l)) + 1;
}
