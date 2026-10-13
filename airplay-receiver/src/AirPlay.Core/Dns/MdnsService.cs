namespace AirPlay.Dns;

/// <summary>One DNS-SD service instance to advertise.</summary>
public sealed class MdnsService
{
    public MdnsService(string serviceType, string instanceName, ushort port, IReadOnlyList<KeyValuePair<string, string>> txt)
    {
        Type = DnsName.Parse(serviceType);
        InstanceName = instanceName;
        Name = DnsName.Instance(instanceName, Type);
        Port = port;
        Txt = txt;
    }

    public DnsName Type { get; }
    public string InstanceName { get; }
    public DnsName Name { get; }
    public ushort Port { get; }
    public IReadOnlyList<KeyValuePair<string, string>> Txt { get; }

    public IEnumerable<string> TxtEntries => Txt.Select(kv => $"{kv.Key}={kv.Value}");

    /// <summary>The TXT record payload in wire format (length-prefixed strings), as sent in GET /info.</summary>
    public byte[] TxtRecordBytes()
    {
        var ms = new MemoryStream();
        foreach (var e in TxtEntries)
        {
            var b = System.Text.Encoding.UTF8.GetBytes(e);
            ms.WriteByte((byte)b.Length);
            ms.Write(b);
        }

        return ms.ToArray();
    }
}
