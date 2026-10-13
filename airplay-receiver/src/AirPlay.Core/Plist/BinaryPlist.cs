using System.Buffers.Binary;
using System.Text;

namespace AirPlay.Plist;

/// <summary>
/// Reader and writer for Apple's binary property list format ("bplist00").
/// This is the only plist flavour iOS uses on the AirPlay control connection.
/// </summary>
public static class BinaryPlist
{
    private static readonly byte[] Magic = "bplist00"u8.ToArray();
    private static readonly DateTime AppleEpoch = new(2001, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    public static bool LooksLikeBinaryPlist(ReadOnlySpan<byte> data) => data.Length >= 40 && data[..8].SequenceEqual(Magic);

    // ------------------------------------------------------------------ reading

    public static object? Parse(ReadOnlySpan<byte> data)
    {
        if (!LooksLikeBinaryPlist(data))
        {
            throw new FormatException("Not a binary plist (missing bplist00 header).");
        }

        var trailer = data[^32..];
        int offsetIntSize = trailer[6];
        int objectRefSize = trailer[7];
        var numObjects = (long)BinaryPrimitives.ReadUInt64BigEndian(trailer[8..16]);
        var topObject = (long)BinaryPrimitives.ReadUInt64BigEndian(trailer[16..24]);
        var offsetTableOffset = (long)BinaryPrimitives.ReadUInt64BigEndian(trailer[24..32]);

        if (offsetIntSize is < 1 or > 8 || objectRefSize is < 1 or > 8 || numObjects <= 0 || numObjects > 1_000_000
            || offsetTableOffset < 8 || offsetTableOffset + numObjects * offsetIntSize > data.Length - 32 || topObject >= numObjects)
        {
            throw new FormatException("Corrupt binary plist trailer.");
        }

        var offsets = new long[numObjects];
        for (var i = 0; i < numObjects; i++)
        {
            offsets[i] = (long)ReadUIntN(data, (int)(offsetTableOffset + i * offsetIntSize), offsetIntSize);
        }

        var reader = new Reader(data.ToArray(), offsets, objectRefSize);
        return reader.ReadObject(topObject, 0);
    }

    public static PlistDict ParseDict(ReadOnlySpan<byte> data) =>
        Parse(data) as PlistDict ?? throw new FormatException("Binary plist root is not a dictionary.");

    private static ulong ReadUIntN(ReadOnlySpan<byte> data, int offset, int size)
    {
        ulong v = 0;
        for (var i = 0; i < size; i++)
        {
            v = (v << 8) | data[offset + i];
        }

        return v;
    }

    private sealed class Reader
    {
        private readonly byte[] _data;
        private readonly long[] _offsets;
        private readonly int _refSize;

        public Reader(byte[] data, long[] offsets, int refSize)
        {
            _data = data;
            _offsets = offsets;
            _refSize = refSize;
        }

        public object? ReadObject(long index, int depth)
        {
            if (depth > 64)
            {
                throw new FormatException("Binary plist nesting too deep.");
            }

            if (index < 0 || index >= _offsets.Length)
            {
                throw new FormatException("Binary plist object reference out of range.");
            }

            var pos = (int)_offsets[index];
            if (pos < 8 || pos >= _data.Length)
            {
                throw new FormatException("Binary plist object offset out of range.");
            }

            var marker = _data[pos];
            var high = marker >> 4;
            var low = marker & 0x0F;
            pos++;

            switch (high)
            {
                case 0x0:
                    return low switch
                    {
                        0x0 => null,
                        0x8 => false,
                        0x9 => true,
                        0xF => null, // fill byte
                        _ => throw new FormatException($"Unknown plist singleton marker 0x{marker:x2}."),
                    };
                case 0x1:
                {
                    var size = 1 << low;
                    Need(pos, size);
                    if (size <= 8)
                    {
                        var raw = ReadUIntN(_data, pos, size);
                        // 1, 2 and 4 byte ints are unsigned; 8 byte ints are signed.
                        return size == 8 ? unchecked((long)raw) : (long)raw;
                    }

                    // 16-byte integer: only the low 8 bytes are used in practice.
                    return unchecked((long)ReadUIntN(_data, pos + 8, 8));
                }
                case 0x2:
                {
                    var size = 1 << low;
                    Need(pos, size);
                    return size switch
                    {
                        4 => (double)BinaryPrimitives.ReadSingleBigEndian(_data.AsSpan(pos, 4)),
                        8 => BinaryPrimitives.ReadDoubleBigEndian(_data.AsSpan(pos, 8)),
                        _ => throw new FormatException("Unsupported plist real size."),
                    };
                }
                case 0x3:
                {
                    Need(pos, 8);
                    var seconds = BinaryPrimitives.ReadDoubleBigEndian(_data.AsSpan(pos, 8));
                    return AppleEpoch.AddSeconds(seconds);
                }
                case 0x4:
                {
                    var count = ReadCount(ref pos, low);
                    Need(pos, count);
                    return _data.AsSpan(pos, count).ToArray();
                }
                case 0x5:
                {
                    var count = ReadCount(ref pos, low);
                    Need(pos, count);
                    return Encoding.ASCII.GetString(_data, pos, count);
                }
                case 0x6:
                {
                    var count = ReadCount(ref pos, low);
                    Need(pos, count * 2);
                    return Encoding.BigEndianUnicode.GetString(_data, pos, count * 2);
                }
                case 0x7:
                {
                    var count = ReadCount(ref pos, low);
                    Need(pos, count);
                    return Encoding.UTF8.GetString(_data, pos, count);
                }
                case 0x8:
                {
                    var size = low + 1;
                    Need(pos, size);
                    return new PlistUid(ReadUIntN(_data, pos, size));
                }
                case 0xA:
                case 0xC:
                {
                    var count = ReadCount(ref pos, low);
                    Need(pos, count * _refSize);
                    var list = new List<object?>(count);
                    for (var i = 0; i < count; i++)
                    {
                        var r = (long)ReadUIntN(_data, pos + i * _refSize, _refSize);
                        list.Add(ReadObject(r, depth + 1));
                    }

                    return list;
                }
                case 0xD:
                {
                    var count = ReadCount(ref pos, low);
                    Need(pos, count * _refSize * 2);
                    var dict = new PlistDict();
                    for (var i = 0; i < count; i++)
                    {
                        var kr = (long)ReadUIntN(_data, pos + i * _refSize, _refSize);
                        var vr = (long)ReadUIntN(_data, pos + (count + i) * _refSize, _refSize);
                        var key = ReadObject(kr, depth + 1) as string ?? throw new FormatException("Plist dictionary key is not a string.");
                        dict[key] = ReadObject(vr, depth + 1);
                    }

                    return dict;
                }
                default:
                    throw new FormatException($"Unknown plist marker 0x{marker:x2}.");
            }
        }

        private int ReadCount(ref int pos, int low)
        {
            if (low != 0xF)
            {
                return low;
            }

            Need(pos, 1);
            var intMarker = _data[pos++];
            if ((intMarker >> 4) != 0x1)
            {
                throw new FormatException("Plist length prefix is not an integer.");
            }

            var size = 1 << (intMarker & 0x0F);
            Need(pos, size);
            var count = ReadUIntN(_data, pos, size);
            pos += size;
            if (count > int.MaxValue)
            {
                throw new FormatException("Plist length too large.");
            }

            return (int)count;
        }

        private void Need(int pos, int count)
        {
            if (count < 0 || pos + count > _data.Length)
            {
                throw new FormatException("Binary plist truncated.");
            }
        }
    }

    // ------------------------------------------------------------------ writing

    public static byte[] Write(object? root)
    {
        var writer = new Writer();
        writer.Flatten(root);
        return writer.Serialize();
    }

    private sealed class Writer
    {
        private readonly List<object?> _objects = new();
        private readonly List<long> _offsets = new();
        private readonly MemoryStream _out = new();
        private int _refSize;

        public void Flatten(object? value)
        {
            // Every object, including duplicates, gets its own slot. Simple and unambiguous.
            _objects.Add(value);
            switch (value)
            {
                case PlistDict dict:
                    foreach (var kv in dict)
                    {
                        Flatten(kv.Key);
                    }

                    foreach (var kv in dict)
                    {
                        Flatten(kv.Value);
                    }

                    break;
                case IReadOnlyDictionary<string, object?> ro:
                    foreach (var kv in ro)
                    {
                        Flatten(kv.Key);
                    }

                    foreach (var kv in ro)
                    {
                        Flatten(kv.Value);
                    }

                    break;
                case IList<object?> list:
                    foreach (var item in list)
                    {
                        Flatten(item);
                    }

                    break;
            }
        }

        public byte[] Serialize()
        {
            _refSize = SizeFor((ulong)_objects.Count);
            _out.Write(Magic);
            var cursor = 0;
            WriteObject(ref cursor);

            var offsetTableOffset = _out.Length;
            var offsetIntSize = SizeFor((ulong)offsetTableOffset);
            foreach (var off in _offsets)
            {
                WriteUIntN((ulong)off, offsetIntSize);
            }

            Span<byte> trailer = stackalloc byte[32];
            trailer.Clear();
            trailer[6] = (byte)offsetIntSize;
            trailer[7] = (byte)_refSize;
            BinaryPrimitives.WriteUInt64BigEndian(trailer[8..16], (ulong)_objects.Count);
            BinaryPrimitives.WriteUInt64BigEndian(trailer[16..24], 0);
            BinaryPrimitives.WriteUInt64BigEndian(trailer[24..32], (ulong)offsetTableOffset);
            _out.Write(trailer);
            return _out.ToArray();
        }

        private static int SizeFor(ulong value)
        {
            if (value <= 0xFF)
            {
                return 1;
            }

            if (value <= 0xFFFF)
            {
                return 2;
            }

            if (value <= 0xFFFFFFFF)
            {
                return 4;
            }

            return 8;
        }

        /// <summary>Writes the object at <paramref name="index"/> and, recursively, its children in flatten order.</summary>
        private void WriteObject(ref int index)
        {
            var myIndex = index++;
            var value = _objects[myIndex];
            _offsets.Add(_out.Length);

            switch (value)
            {
                case null:
                    _out.WriteByte(0x00);
                    break;
                case bool b:
                    _out.WriteByte(b ? (byte)0x09 : (byte)0x08);
                    break;
                case int i:
                    WriteInt(i);
                    break;
                case long l:
                    WriteInt(l);
                    break;
                case ulong ul:
                    WriteInt(unchecked((long)ul));
                    break;
                case float f:
                    _out.WriteByte(0x23);
                    WriteDouble(f);
                    break;
                case double d:
                    _out.WriteByte(0x23);
                    WriteDouble(d);
                    break;
                case DateTime dt:
                    _out.WriteByte(0x33);
                    WriteDouble((dt.ToUniversalTime() - AppleEpoch).TotalSeconds);
                    break;
                case byte[] data:
                    WriteMarkerAndCount(0x4, data.Length);
                    _out.Write(data);
                    break;
                case string s:
                    WriteString(s);
                    break;
                case PlistUid uid:
                {
                    var size = SizeFor(uid.Value);
                    _out.WriteByte((byte)(0x80 | (size - 1)));
                    WriteUIntN(uid.Value, size);
                    break;
                }
                case PlistDict dict:
                    WriteDict(dict.Count, ref index);
                    break;
                case IReadOnlyDictionary<string, object?> ro:
                    WriteDict(ro.Count, ref index);
                    break;
                case IList<object?> list:
                {
                    WriteMarkerAndCount(0xA, list.Count);
                    var first = index;
                    // Children occupy the next list.Count flatten slots (depth-first), so their refs are known up front.
                    var refs = new List<int>(list.Count);
                    var probe = first;
                    for (var i = 0; i < list.Count; i++)
                    {
                        refs.Add(probe);
                        probe = SkipSubtree(probe);
                    }

                    foreach (var r in refs)
                    {
                        WriteUIntN((ulong)r, _refSize);
                    }

                    for (var i = 0; i < list.Count; i++)
                    {
                        WriteObject(ref index);
                    }

                    break;
                }
                default:
                    throw new NotSupportedException($"Cannot serialize {value.GetType()} to a plist.");
            }
        }

        private void WriteDict(int count, ref int index)
        {
            WriteMarkerAndCount(0xD, count);
            var probe = index;
            var refs = new List<int>(count * 2);
            for (var i = 0; i < count * 2; i++)
            {
                refs.Add(probe);
                probe = SkipSubtree(probe);
            }

            foreach (var r in refs)
            {
                WriteUIntN((ulong)r, _refSize);
            }

            for (var i = 0; i < count * 2; i++)
            {
                WriteObject(ref index);
            }
        }

        /// <summary>Returns the flatten index just past the subtree rooted at <paramref name="index"/>.</summary>
        private int SkipSubtree(int index)
        {
            var value = _objects[index];
            index++;
            switch (value)
            {
                case PlistDict dict:
                    for (var i = 0; i < dict.Count * 2; i++)
                    {
                        index = SkipSubtree(index);
                    }

                    break;
                case IReadOnlyDictionary<string, object?> ro:
                    for (var i = 0; i < ro.Count * 2; i++)
                    {
                        index = SkipSubtree(index);
                    }

                    break;
                case IList<object?> list:
                    for (var i = 0; i < list.Count; i++)
                    {
                        index = SkipSubtree(index);
                    }

                    break;
            }

            return index;
        }

        private void WriteInt(long value)
        {
            if (value < 0)
            {
                _out.WriteByte(0x13);
                WriteUIntN(unchecked((ulong)value), 8);
                return;
            }

            var size = SizeFor((ulong)value);
            var exp = size switch { 1 => 0, 2 => 1, 4 => 2, _ => 3 };
            _out.WriteByte((byte)(0x10 | exp));
            WriteUIntN((ulong)value, size);
        }

        private void WriteDouble(double value)
        {
            Span<byte> buf = stackalloc byte[8];
            BinaryPrimitives.WriteDoubleBigEndian(buf, value);
            _out.Write(buf);
        }

        private void WriteString(string s)
        {
            var ascii = true;
            foreach (var ch in s)
            {
                if (ch > 0x7F)
                {
                    ascii = false;
                    break;
                }
            }

            if (ascii)
            {
                WriteMarkerAndCount(0x5, s.Length);
                _out.Write(Encoding.ASCII.GetBytes(s));
            }
            else
            {
                var utf16 = Encoding.BigEndianUnicode.GetBytes(s);
                WriteMarkerAndCount(0x6, utf16.Length / 2);
                _out.Write(utf16);
            }
        }

        private void WriteMarkerAndCount(int high, int count)
        {
            if (count < 0xF)
            {
                _out.WriteByte((byte)((high << 4) | count));
                return;
            }

            _out.WriteByte((byte)((high << 4) | 0xF));
            WriteInt(count);
        }

        private void WriteUIntN(ulong value, int size)
        {
            Span<byte> buf = stackalloc byte[8];
            BinaryPrimitives.WriteUInt64BigEndian(buf, value);
            _out.Write(buf[(8 - size)..]);
        }
    }
}
