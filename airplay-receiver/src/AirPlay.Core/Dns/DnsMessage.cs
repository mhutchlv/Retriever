using System.Buffers.Binary;
using System.Net;
using System.Text;

namespace AirPlay.Dns;

public static class DnsType
{
    public const ushort A = 1;
    public const ushort PTR = 12;
    public const ushort TXT = 16;
    public const ushort AAAA = 28;
    public const ushort SRV = 33;
    public const ushort NSEC = 47;
    public const ushort ANY = 255;
}

public sealed record DnsQuestion(DnsName Name, ushort Type, ushort Class, bool UnicastResponse);

/// <summary>A resource record as parsed from a packet (rdata kept raw except for PTR, which we need for known-answer suppression).</summary>
public sealed record DnsRecordView(DnsName Name, ushort Type, ushort Class, uint Ttl, DnsName? PtrTarget);

public sealed class DnsMessageView
{
    public ushort Id { get; init; }
    public ushort Flags { get; init; }
    public bool IsResponse => (Flags & 0x8000) != 0;
    public List<DnsQuestion> Questions { get; } = new();
    public List<DnsRecordView> Answers { get; } = new();
}

/// <summary>Parses just enough of a DNS/mDNS packet to answer queries.</summary>
public static class DnsReader
{
    public static DnsMessageView? TryParse(ReadOnlySpan<byte> packet)
    {
        try
        {
            return Parse(packet);
        }
        catch (Exception)
        {
            return null;
        }
    }

    public static DnsMessageView Parse(ReadOnlySpan<byte> packet)
    {
        if (packet.Length < 12)
        {
            throw new FormatException("DNS packet too short.");
        }

        var msg = new DnsMessageView
        {
            Id = BinaryPrimitives.ReadUInt16BigEndian(packet),
            Flags = BinaryPrimitives.ReadUInt16BigEndian(packet[2..]),
        };
        int qd = BinaryPrimitives.ReadUInt16BigEndian(packet[4..]);
        int an = BinaryPrimitives.ReadUInt16BigEndian(packet[6..]);
        var pos = 12;
        for (var i = 0; i < qd; i++)
        {
            var name = ReadName(packet, ref pos);
            var type = BinaryPrimitives.ReadUInt16BigEndian(packet[pos..]);
            var cls = BinaryPrimitives.ReadUInt16BigEndian(packet[(pos + 2)..]);
            pos += 4;
            msg.Questions.Add(new DnsQuestion(name, type, (ushort)(cls & 0x7FFF), (cls & 0x8000) != 0));
        }

        for (var i = 0; i < an; i++)
        {
            var name = ReadName(packet, ref pos);
            var type = BinaryPrimitives.ReadUInt16BigEndian(packet[pos..]);
            var cls = BinaryPrimitives.ReadUInt16BigEndian(packet[(pos + 2)..]);
            var ttl = BinaryPrimitives.ReadUInt32BigEndian(packet[(pos + 4)..]);
            int rdlen = BinaryPrimitives.ReadUInt16BigEndian(packet[(pos + 8)..]);
            pos += 10;
            DnsName? ptr = null;
            if (type == DnsType.PTR)
            {
                var p = pos;
                ptr = ReadName(packet, ref p);
            }

            pos += rdlen;
            msg.Answers.Add(new DnsRecordView(name, type, (ushort)(cls & 0x7FFF), ttl, ptr));
        }

        return msg;
    }

    public static DnsName ReadName(ReadOnlySpan<byte> packet, ref int pos)
    {
        var labels = new List<string>();
        var jumped = false;
        var end = pos;
        var hops = 0;
        var p = pos;
        while (true)
        {
            if (p >= packet.Length)
            {
                throw new FormatException("DNS name runs past packet.");
            }

            int len = packet[p];
            if (len == 0)
            {
                p++;
                break;
            }

            if ((len & 0xC0) == 0xC0)
            {
                if (p + 1 >= packet.Length)
                {
                    throw new FormatException("Truncated DNS pointer.");
                }

                var target = ((len & 0x3F) << 8) | packet[p + 1];
                if (!jumped)
                {
                    end = p + 2;
                }

                jumped = true;
                if (++hops > 32 || target >= p)
                {
                    throw new FormatException("Bad DNS compression pointer.");
                }

                p = target;
                continue;
            }

            if ((len & 0xC0) != 0)
            {
                throw new FormatException("Unsupported DNS label type.");
            }

            p++;
            if (p + len > packet.Length)
            {
                throw new FormatException("DNS label runs past packet.");
            }

            labels.Add(Encoding.UTF8.GetString(packet.Slice(p, len)));
            p += len;
            if (labels.Count > 64)
            {
                throw new FormatException("Too many DNS labels.");
            }
        }

        pos = jumped ? end : p;
        return new DnsName(labels);
    }
}

/// <summary>Builds DNS response packets with name compression.</summary>
public sealed class DnsWriter
{
    public const ushort ClassIn = 1;
    public const ushort CacheFlush = 0x8000;

    private readonly MemoryStream _buf = new();
    private readonly Dictionary<string, int> _compression = new(StringComparer.OrdinalIgnoreCase);
    private int _answerCount;
    private int _additionalCount;
    private bool _inAdditional;

    public DnsWriter(ushort id, bool authoritative = true)
    {
        Span<byte> header = stackalloc byte[12];
        header.Clear();
        BinaryPrimitives.WriteUInt16BigEndian(header, id);
        BinaryPrimitives.WriteUInt16BigEndian(header[2..], (ushort)(0x8000 | (authoritative ? 0x0400 : 0)));
        _buf.Write(header);
    }

    public int Length => (int)_buf.Length;

    public void BeginAdditional() => _inAdditional = true;

    public void AddPtr(DnsName name, DnsName target, uint ttl, bool cacheFlush = false)
    {
        BeginRecord(name, DnsType.PTR, ttl, cacheFlush);
        var start = _buf.Length;
        WriteName(target, compress: true);
        EndRecord(start);
    }

    public void AddSrv(DnsName name, ushort priority, ushort weight, ushort port, DnsName target, uint ttl, bool cacheFlush = true)
    {
        BeginRecord(name, DnsType.SRV, ttl, cacheFlush);
        var start = _buf.Length;
        Span<byte> fixedPart = stackalloc byte[6];
        BinaryPrimitives.WriteUInt16BigEndian(fixedPart, priority);
        BinaryPrimitives.WriteUInt16BigEndian(fixedPart[2..], weight);
        BinaryPrimitives.WriteUInt16BigEndian(fixedPart[4..], port);
        _buf.Write(fixedPart);
        // RFC 2782 forbids compression of the SRV target; some resolvers choke on it, so write it in full.
        WriteName(target, compress: false);
        EndRecord(start);
    }

    public void AddTxt(DnsName name, IEnumerable<string> entries, uint ttl, bool cacheFlush = true)
    {
        BeginRecord(name, DnsType.TXT, ttl, cacheFlush);
        var start = _buf.Length;
        var any = false;
        foreach (var entry in entries)
        {
            var bytes = Encoding.UTF8.GetBytes(entry);
            if (bytes.Length > 255)
            {
                throw new ArgumentException($"TXT entry too long: {entry}");
            }

            _buf.WriteByte((byte)bytes.Length);
            _buf.Write(bytes);
            any = true;
        }

        if (!any)
        {
            _buf.WriteByte(0);
        }

        EndRecord(start);
    }

    public void AddAddress(DnsName name, IPAddress address, uint ttl, bool cacheFlush = true)
    {
        var bytes = address.GetAddressBytes();
        BeginRecord(name, bytes.Length == 4 ? DnsType.A : DnsType.AAAA, ttl, cacheFlush);
        var start = _buf.Length;
        _buf.Write(bytes);
        EndRecord(start);
    }

    /// <summary>NSEC record asserting that only the given types exist for the name (RFC 6762 §6.1).</summary>
    public void AddNsec(DnsName name, uint ttl, params ushort[] types)
    {
        BeginRecord(name, DnsType.NSEC, ttl, cacheFlush: true);
        var start = _buf.Length;
        WriteName(name, compress: false);
        var bitmap = new byte[32];
        var maxByte = 0;
        foreach (var t in types)
        {
            if (t >= 256)
            {
                continue;
            }

            bitmap[t / 8] |= (byte)(0x80 >> (t % 8));
            maxByte = Math.Max(maxByte, t / 8);
        }

        _buf.WriteByte(0);
        _buf.WriteByte((byte)(maxByte + 1));
        _buf.Write(bitmap, 0, maxByte + 1);
        EndRecord(start);
    }

    public byte[] ToArray()
    {
        var bytes = _buf.ToArray();
        BinaryPrimitives.WriteUInt16BigEndian(bytes.AsSpan(6), (ushort)_answerCount);
        BinaryPrimitives.WriteUInt16BigEndian(bytes.AsSpan(10), (ushort)_additionalCount);
        return bytes;
    }

    private void BeginRecord(DnsName name, ushort type, uint ttl, bool cacheFlush)
    {
        WriteName(name, compress: true);
        Span<byte> fixedPart = stackalloc byte[10];
        BinaryPrimitives.WriteUInt16BigEndian(fixedPart, type);
        BinaryPrimitives.WriteUInt16BigEndian(fixedPart[2..], (ushort)(ClassIn | (cacheFlush ? CacheFlush : 0)));
        BinaryPrimitives.WriteUInt32BigEndian(fixedPart[4..], ttl);
        BinaryPrimitives.WriteUInt16BigEndian(fixedPart[8..], 0); // rdlength placeholder
        _buf.Write(fixedPart);
        if (_inAdditional)
        {
            _additionalCount++;
        }
        else
        {
            _answerCount++;
        }
    }

    private void EndRecord(long rdataStart)
    {
        var rdlen = (ushort)(_buf.Length - rdataStart);
        var save = _buf.Position;
        _buf.Position = rdataStart - 2;
        Span<byte> len = stackalloc byte[2];
        BinaryPrimitives.WriteUInt16BigEndian(len, rdlen);
        _buf.Write(len);
        _buf.Position = save;
    }

    private void WriteName(DnsName name, bool compress)
    {
        var labels = name.Labels;
        for (var i = 0; i < labels.Count; i++)
        {
            var suffix = string.Join('.', labels.Skip(i));
            if (compress && _compression.TryGetValue(suffix, out var offset))
            {
                Span<byte> ptr = stackalloc byte[2];
                BinaryPrimitives.WriteUInt16BigEndian(ptr, (ushort)(0xC000 | offset));
                _buf.Write(ptr);
                return;
            }

            if (_buf.Length < 0x3FFF && !_compression.ContainsKey(suffix))
            {
                _compression[suffix] = (int)_buf.Length;
            }

            var bytes = Encoding.UTF8.GetBytes(labels[i]);
            if (bytes.Length is 0 or > 63)
            {
                throw new ArgumentException($"Invalid DNS label '{labels[i]}'.");
            }

            _buf.WriteByte((byte)bytes.Length);
            _buf.Write(bytes);
        }

        _buf.WriteByte(0);
    }
}
