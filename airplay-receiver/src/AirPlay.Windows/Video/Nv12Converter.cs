using AirPlay.Windows.Video.MediaFoundation;

namespace AirPlay.Windows.Video;

/// <summary>NV12 (BT.709, limited range) to 32-bit BGRA, parallelised over row pairs.</summary>
public static unsafe class Nv12Converter
{
    private static readonly int[] YTable = new int[256];
    private static readonly int[] RvTable = new int[256];
    private static readonly int[] GuTable = new int[256];
    private static readonly int[] GvTable = new int[256];
    private static readonly int[] BuTable = new int[256];

    static Nv12Converter()
    {
        for (var i = 0; i < 256; i++)
        {
            YTable[i] = 298 * (i - 16);
            RvTable[i] = 459 * (i - 128);
            GuTable[i] = -55 * (i - 128);
            GvTable[i] = -136 * (i - 128);
            BuTable[i] = 541 * (i - 128);
        }
    }

    /// <summary>Converts the visible area of <paramref name="picture"/> into <paramref name="destination"/> (BGRA, <paramref name="destinationStride"/> bytes per row).</summary>
    public static void Convert(in Nv12Picture picture, byte* destination, int destinationStride)
    {
        var width = picture.Width;
        var height = picture.Height;
        var y0 = picture.Y + (long)picture.YOffset * picture.Pitch + picture.X;
        var uv0 = picture.Uv + (long)(picture.YOffset / 2) * picture.Pitch + (picture.X & ~1);
        var pitch = picture.Pitch;
        var rowPairs = (height + 1) / 2;

        var options = new ParallelOptions { MaxDegreeOfParallelism = Math.Max(1, Environment.ProcessorCount - 1) };
        Parallel.For(0, rowPairs, options, pair =>
        {
            for (var r = 0; r < 2; r++)
            {
                var row = pair * 2 + r;
                if (row >= height)
                {
                    break;
                }

                var yRow = y0 + (long)row * pitch;
                var uvRow = uv0 + (long)pair * pitch;
                var dst = destination + (long)row * destinationStride;
                ConvertRow(yRow, uvRow, dst, width);
            }
        });
    }

    private static void ConvertRow(byte* yRow, byte* uvRow, byte* dst, int width)
    {
        for (var x = 0; x < width; x += 2)
        {
            var u = uvRow[x];
            var v = uvRow[x + 1];
            var rv = RvTable[v];
            var guv = GuTable[u] + GvTable[v];
            var bu = BuTable[u];

            var yv = YTable[yRow[x]];
            dst[0] = Clamp((yv + bu + 128) >> 8);
            dst[1] = Clamp((yv + guv + 128) >> 8);
            dst[2] = Clamp((yv + rv + 128) >> 8);
            dst[3] = 255;
            dst += 4;

            if (x + 1 < width)
            {
                yv = YTable[yRow[x + 1]];
                dst[0] = Clamp((yv + bu + 128) >> 8);
                dst[1] = Clamp((yv + guv + 128) >> 8);
                dst[2] = Clamp((yv + rv + 128) >> 8);
                dst[3] = 255;
                dst += 4;
            }
        }
    }

    private static byte Clamp(int v) => v < 0 ? (byte)0 : v > 255 ? (byte)255 : (byte)v;
}
