using AirPlay;
using AirPlay.Plist;
using Xunit;

namespace AirPlay.Tests;

public class BinaryPlistTests
{
    // plistlib.dumps({...}, fmt=FMT_BINARY) from CPython, see the dictionary below.
    private const string PythonFixture =
        "62706c6973743030dc0102030405060708090a0b0c0d0e0f1011121617181d1e1f53626967546461746155656d70747958666561747572657354666c6167546c697374546e616d65536e6567566e6573746564536f6666547265616c55736d616c6c131234567890abcdef4f1014000102030405060708090a0b0c0d0e0f1011121340130000001e5a7ffee609a313141510015374776f234008000000000000594d61726b277320504313ffffffffffffcfc7d2191a1b1c516b57756e69636f6465517668005a00fc00720069006300680020261508233f90ff972474538f10070821252a30393e43484c53575c626b82838c8d919397a0aab3b8bac2c4d5d6df00000000000001010000000000000020000000000000000000000000000000e1";

    [Fact]
    public void ParsesPythonGeneratedPlist()
    {
        var dict = BinaryPlist.ParseDict(Hex.Parse(PythonFixture));
        Assert.Equal("Mark's PC", dict.GetString("name"));
        Assert.Equal(0x1E5A7FFEE6L, dict.GetInt("features"));
        Assert.Equal(-12345L, dict.GetInt("neg"));
        Assert.Equal(7L, dict.GetInt("small"));
        Assert.Equal(0.0166, dict.GetReal("real")!.Value, 10);
        Assert.True(dict.GetBool("flag"));
        Assert.False(dict.GetBool("off"));
        Assert.Equal(Enumerable.Range(0, 20).Select(i => (byte)i).ToArray(), dict.GetData("data"));
        Assert.Empty(dict.GetData("empty")!);
        var list = dict.GetArray("list")!;
        Assert.Equal(3, list.Count);
        Assert.Equal(1L, list[0]);
        Assert.Equal("two", list[1]);
        Assert.Equal(3.0, list[2]);
        var nested = dict.GetDict("nested")!;
        Assert.Equal("v", nested.GetString("k"));
        Assert.Equal("Zürich ☕", nested.GetString("unicode"));
        Assert.Equal(0x1234567890ABCDEFL, dict.GetInt("big"));
    }

    [Fact]
    public void RoundTripsAllValueKinds()
    {
        var original = new PlistDict
        {
            ["name"] = "Mark's PC",
            ["unicode"] = "Zürich ☕",
            ["features"] = 0x1E5A7FFEE6L,
            ["neg"] = -1L,
            ["zero"] = 0L,
            ["u8"] = 255L,
            ["u16"] = 65535L,
            ["u32"] = 4294967295L,
            ["real"] = 1.0 / 60,
            ["flag"] = true,
            ["off"] = false,
            ["nothing"] = null,
            ["data"] = new byte[300],
            ["longstring"] = new string('x', 1000),
            ["list"] = new List<object?> { 1L, "two", new PlistDict { ["deep"] = new List<object?> { 3L } } },
            ["streams"] = new List<object?> { new PlistDict { ["type"] = 110L, ["streamConnectionID"] = -4903871290523402176L } },
        };

        var bytes = BinaryPlist.Write(original);
        Assert.True(BinaryPlist.LooksLikeBinaryPlist(bytes));
        var parsed = BinaryPlist.ParseDict(bytes);
        Assert.Equal("Mark's PC", parsed.GetString("name"));
        Assert.Equal("Zürich ☕", parsed.GetString("unicode"));
        Assert.Equal(0x1E5A7FFEE6L, parsed.GetInt("features"));
        Assert.Equal(-1L, parsed.GetInt("neg"));
        Assert.Equal(0L, parsed.GetInt("zero"));
        Assert.Equal(255L, parsed.GetInt("u8"));
        Assert.Equal(65535L, parsed.GetInt("u16"));
        Assert.Equal(4294967295L, parsed.GetInt("u32"));
        Assert.Equal(1.0 / 60, parsed.GetReal("real")!.Value, 12);
        Assert.True(parsed.GetBool("flag"));
        Assert.False(parsed.GetBool("off"));
        Assert.True(parsed.ContainsKey("nothing"));
        Assert.Null(parsed["nothing"]);
        Assert.Equal(300, parsed.GetData("data")!.Length);
        Assert.Equal(1000, parsed.GetString("longstring")!.Length);
        var list = parsed.GetArray("list")!;
        Assert.Equal(1L, list[0]);
        Assert.Equal(3L, ((PlistDict)list[2]!).GetArray("deep")![0]);
        var stream = (PlistDict)parsed.GetArray("streams")![0]!;
        Assert.Equal(-4903871290523402176L, stream.GetInt("streamConnectionID"));
        Assert.Equal(13542872783186149440UL, unchecked((ulong)stream.GetInt("streamConnectionID")!.Value));
    }

    [Fact]
    public void RejectsGarbage()
    {
        Assert.Throws<FormatException>(() => BinaryPlist.Parse(new byte[50]));
        var good = BinaryPlist.Write(new PlistDict { ["a"] = 1L });
        var truncated = good[..^5];
        Assert.ThrowsAny<Exception>(() => BinaryPlist.Parse(truncated));
    }

    [Fact]
    public void ManyObjectsUseWiderReferences()
    {
        var list = new List<object?>();
        for (var i = 0; i < 300; i++)
        {
            list.Add((long)i);
        }

        var parsed = (List<object?>)BinaryPlist.Parse(BinaryPlist.Write(list))!;
        Assert.Equal(300, parsed.Count);
        Assert.Equal(299L, parsed[299]);
    }
}
