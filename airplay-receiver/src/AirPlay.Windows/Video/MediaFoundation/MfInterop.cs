using System.Runtime.InteropServices;

namespace AirPlay.Windows.Video.MediaFoundation;

/// <summary>Hand-written COM interop for the small slice of Media Foundation the decoder needs.</summary>
internal static class Mf
{
    public const int MF_VERSION = 0x00020070;
    public const int MFSTARTUP_FULL = 0;

    public const int S_OK = 0;
    public const int E_NOTIMPL = unchecked((int)0x80004001);
    public const int E_FAIL = unchecked((int)0x80004005);
    public const int MF_E_TRANSFORM_NEED_MORE_INPUT = unchecked((int)0xC00D6D72);
    public const int MF_E_TRANSFORM_STREAM_CHANGE = unchecked((int)0xC00D6D61);
    public const int MF_E_NOTACCEPTING = unchecked((int)0xC00D36B5);
    public const int MF_E_NO_MORE_TYPES = unchecked((int)0xC00D36B9);
    public const int MF_E_ATTRIBUTENOTFOUND = unchecked((int)0xC00D36E6);

    public const uint MFT_OUTPUT_STREAM_PROVIDES_SAMPLES = 0x100;
    public const uint MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES = 0x200;

    public const int MFT_MESSAGE_COMMAND_FLUSH = 0;
    public const int MFT_MESSAGE_COMMAND_DRAIN = 1;
    public const int MFT_MESSAGE_NOTIFY_BEGIN_STREAMING = 0x10000000;
    public const int MFT_MESSAGE_NOTIFY_END_STREAMING = 0x10000001;
    public const int MFT_MESSAGE_NOTIFY_END_OF_STREAM = 0x10000002;
    public const int MFT_MESSAGE_NOTIFY_START_OF_STREAM = 0x10000003;

    public const uint MFVideoInterlace_Progressive = 2;

    public static readonly Guid MFMediaType_Video = new("73646976-0000-0010-8000-00AA00389B71");
    public static readonly Guid MFVideoFormat_H264 = new("34363248-0000-0010-8000-00AA00389B71");
    public static readonly Guid MFVideoFormat_HEVC = new("43564548-0000-0010-8000-00AA00389B71");
    public static readonly Guid MFVideoFormat_NV12 = new("3231564E-0000-0010-8000-00AA00389B71");

    public static readonly Guid MF_MT_MAJOR_TYPE = new("48EBA18E-F8C9-4687-BF11-0A74C9F96A8F");
    public static readonly Guid MF_MT_SUBTYPE = new("F7E34C9A-42E8-4714-B74B-CB29D72C35E5");
    public static readonly Guid MF_MT_FRAME_SIZE = new("1652C33D-D6B2-4012-B834-72030849A37D");
    public static readonly Guid MF_MT_FRAME_RATE = new("C459A2E8-3D2C-4E44-B132-FEE5156C7BB0");
    public static readonly Guid MF_MT_PIXEL_ASPECT_RATIO = new("C6376A1E-8D0A-4027-BE45-6D9A0AD39BB6");
    public static readonly Guid MF_MT_INTERLACE_MODE = new("E2724BB1-E2A6-4F9D-9F3D-7F7BCDE7F8C2");
    public static readonly Guid MF_MT_DEFAULT_STRIDE = new("644B4E48-1E02-4516-B0EB-C01CA9D49AC6");
    public static readonly Guid MF_MT_MINIMUM_DISPLAY_APERTURE = new("D7388766-18FE-48C6-A177-EE894867C8C4");
    public static readonly Guid MF_LOW_LATENCY = new("9C27891A-ED7A-40E1-88E8-B22727A024EE");
    public static readonly Guid CODECAPI_AVLowLatencyMode = new("9C27891A-ED7A-40E1-88E8-B22727A024EE");
    public static readonly Guid CODECAPI_AVDecVideoThreadCount = new("AAD5E65A-CEE1-4E5B-8E6E-D63E4D64D3E9");

    public static readonly Guid CLSID_CMSH264DecoderMFT = new("62CE7E72-4C71-4D20-B15D-452831A87D9D");
    public static readonly Guid CLSID_CMSHEVCDecoderMFT = new("420A51A3-D605-430C-B4FC-45274FA6C562");

    public static readonly Guid IID_IMFTransform = new("BF94C121-5B05-4E6F-8000-BA598961414D");

    public const uint CLSCTX_INPROC_SERVER = 1;

    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFStartup(int version, int flags);

    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFShutdown();

    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFCreateMediaType(out IMFMediaType type);

    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFCreateSample(out IMFSample sample);

    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFCreateMemoryBuffer(int maxLength, out IMFMediaBuffer buffer);

    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFCreateAlignedMemoryBuffer(int maxLength, int alignment, out IMFMediaBuffer buffer);

    [DllImport("ole32.dll", ExactSpelling = true)]
    public static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, out IntPtr instance);

    public static void Check(int hr, string what)
    {
        if (hr < 0)
        {
            throw new MediaFoundationException(what, hr);
        }
    }

    public static ulong Pack(uint high, uint low) => ((ulong)high << 32) | low;
}

public sealed class MediaFoundationException : Exception
{
    public MediaFoundationException(string what, int hr) : base($"{what} failed: HRESULT 0x{hr:X8}")
    {
        HResult = hr;
    }
}

[StructLayout(LayoutKind.Sequential)]
internal struct MFT_INPUT_STREAM_INFO
{
    public long hnsMaxLatency;
    public uint dwFlags;
    public uint cbSize;
    public uint cbMaxLookahead;
    public uint cbAlignment;
}

[StructLayout(LayoutKind.Sequential)]
internal struct MFT_OUTPUT_STREAM_INFO
{
    public uint dwFlags;
    public uint cbSize;
    public uint cbAlignment;
}

[StructLayout(LayoutKind.Sequential)]
internal struct MFT_OUTPUT_DATA_BUFFER
{
    public uint dwStreamID;
    public IntPtr pSample;
    public uint dwStatus;
    public IntPtr pEvents;
}

/// <summary>MFVideoArea as stored in MF_MT_MINIMUM_DISPLAY_APERTURE (two MFOffset + SIZE).</summary>
[StructLayout(LayoutKind.Sequential)]
internal struct MFVideoArea
{
    public ushort OffsetXFract;
    public short OffsetXValue;
    public ushort OffsetYFract;
    public short OffsetYValue;
    public int Width;
    public int Height;
}

/// <summary>A VARIANT large enough for VT_BOOL / VT_UI4, for ICodecAPI::SetValue.</summary>
[StructLayout(LayoutKind.Sequential)]
internal struct Variant
{
    public ushort vt;
    public ushort reserved1;
    public ushort reserved2;
    public ushort reserved3;
    public long data1;
    public long data2;

    public const ushort VT_BOOL = 11;
    public const ushort VT_UI4 = 19;

    public static Variant Bool(bool value) => new() { vt = VT_BOOL, data1 = value ? 0xFFFF : 0 };

    public static Variant UInt32(uint value) => new() { vt = VT_UI4, data1 = value };
}

[ComImport, Guid("2CD2D921-C447-44A7-A13C-4ADABFC247E3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMFAttributes
{
    [PreserveSig] int GetItem([In] ref Guid key, IntPtr value);
    [PreserveSig] int GetItemType([In] ref Guid key, out int type);
    [PreserveSig] int CompareItem([In] ref Guid key, IntPtr value, out int result);
    [PreserveSig] int Compare(IMFAttributes theirs, int matchType, out int result);
    [PreserveSig] int GetUINT32([In] ref Guid key, out uint value);
    [PreserveSig] int GetUINT64([In] ref Guid key, out ulong value);
    [PreserveSig] int GetDouble([In] ref Guid key, out double value);
    [PreserveSig] int GetGUID([In] ref Guid key, out Guid value);
    [PreserveSig] int GetStringLength([In] ref Guid key, out uint length);
    [PreserveSig] int GetString([In] ref Guid key, IntPtr value, uint size, out uint length);
    [PreserveSig] int GetAllocatedString([In] ref Guid key, out IntPtr value, out uint length);
    [PreserveSig] int GetBlobSize([In] ref Guid key, out uint size);
    [PreserveSig] int GetBlob([In] ref Guid key, IntPtr buffer, uint size, out uint written);
    [PreserveSig] int GetAllocatedBlob([In] ref Guid key, out IntPtr buffer, out uint size);
    [PreserveSig] int GetUnknown([In] ref Guid key, [In] ref Guid iid, out IntPtr value);
    [PreserveSig] int SetItem([In] ref Guid key, IntPtr value);
    [PreserveSig] int DeleteItem([In] ref Guid key);
    [PreserveSig] int DeleteAllItems();
    [PreserveSig] int SetUINT32([In] ref Guid key, uint value);
    [PreserveSig] int SetUINT64([In] ref Guid key, ulong value);
    [PreserveSig] int SetDouble([In] ref Guid key, double value);
    [PreserveSig] int SetGUID([In] ref Guid key, [In] ref Guid value);
    [PreserveSig] int SetString([In] ref Guid key, [MarshalAs(UnmanagedType.LPWStr)] string value);
    [PreserveSig] int SetBlob([In] ref Guid key, IntPtr buffer, uint size);
    [PreserveSig] int SetUnknown([In] ref Guid key, IntPtr value);
    [PreserveSig] int LockStore();
    [PreserveSig] int UnlockStore();
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetItemByIndex(uint index, out Guid key, IntPtr value);
    [PreserveSig] int CopyAllItems(IMFAttributes destination);
}

[ComImport, Guid("44AE0FA8-EA31-4109-8D2E-4CAE4997C555"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMFMediaType : IMFAttributes
{
    // IMFAttributes (re-declared so the vtable is exact and no QueryInterface is needed)
    [PreserveSig] new int GetItem([In] ref Guid key, IntPtr value);
    [PreserveSig] new int GetItemType([In] ref Guid key, out int type);
    [PreserveSig] new int CompareItem([In] ref Guid key, IntPtr value, out int result);
    [PreserveSig] new int Compare(IMFAttributes theirs, int matchType, out int result);
    [PreserveSig] new int GetUINT32([In] ref Guid key, out uint value);
    [PreserveSig] new int GetUINT64([In] ref Guid key, out ulong value);
    [PreserveSig] new int GetDouble([In] ref Guid key, out double value);
    [PreserveSig] new int GetGUID([In] ref Guid key, out Guid value);
    [PreserveSig] new int GetStringLength([In] ref Guid key, out uint length);
    [PreserveSig] new int GetString([In] ref Guid key, IntPtr value, uint size, out uint length);
    [PreserveSig] new int GetAllocatedString([In] ref Guid key, out IntPtr value, out uint length);
    [PreserveSig] new int GetBlobSize([In] ref Guid key, out uint size);
    [PreserveSig] new int GetBlob([In] ref Guid key, IntPtr buffer, uint size, out uint written);
    [PreserveSig] new int GetAllocatedBlob([In] ref Guid key, out IntPtr buffer, out uint size);
    [PreserveSig] new int GetUnknown([In] ref Guid key, [In] ref Guid iid, out IntPtr value);
    [PreserveSig] new int SetItem([In] ref Guid key, IntPtr value);
    [PreserveSig] new int DeleteItem([In] ref Guid key);
    [PreserveSig] new int DeleteAllItems();
    [PreserveSig] new int SetUINT32([In] ref Guid key, uint value);
    [PreserveSig] new int SetUINT64([In] ref Guid key, ulong value);
    [PreserveSig] new int SetDouble([In] ref Guid key, double value);
    [PreserveSig] new int SetGUID([In] ref Guid key, [In] ref Guid value);
    [PreserveSig] new int SetString([In] ref Guid key, [MarshalAs(UnmanagedType.LPWStr)] string value);
    [PreserveSig] new int SetBlob([In] ref Guid key, IntPtr buffer, uint size);
    [PreserveSig] new int SetUnknown([In] ref Guid key, IntPtr value);
    [PreserveSig] new int LockStore();
    [PreserveSig] new int UnlockStore();
    [PreserveSig] new int GetCount(out uint count);
    [PreserveSig] new int GetItemByIndex(uint index, out Guid key, IntPtr value);
    [PreserveSig] new int CopyAllItems(IMFAttributes destination);

    // IMFMediaType
    [PreserveSig] int GetMajorType(out Guid majorType);
    [PreserveSig] int IsCompressedFormat(out int compressed);
    [PreserveSig] int IsEqual(IMFMediaType other, out uint flags);
    [PreserveSig] int GetRepresentation(Guid representation, out IntPtr value);
    [PreserveSig] int FreeRepresentation(Guid representation, IntPtr value);
}

[ComImport, Guid("C40A00F2-B93A-4D80-AE8C-5A1C634F58E4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMFSample : IMFAttributes
{
    [PreserveSig] new int GetItem([In] ref Guid key, IntPtr value);
    [PreserveSig] new int GetItemType([In] ref Guid key, out int type);
    [PreserveSig] new int CompareItem([In] ref Guid key, IntPtr value, out int result);
    [PreserveSig] new int Compare(IMFAttributes theirs, int matchType, out int result);
    [PreserveSig] new int GetUINT32([In] ref Guid key, out uint value);
    [PreserveSig] new int GetUINT64([In] ref Guid key, out ulong value);
    [PreserveSig] new int GetDouble([In] ref Guid key, out double value);
    [PreserveSig] new int GetGUID([In] ref Guid key, out Guid value);
    [PreserveSig] new int GetStringLength([In] ref Guid key, out uint length);
    [PreserveSig] new int GetString([In] ref Guid key, IntPtr value, uint size, out uint length);
    [PreserveSig] new int GetAllocatedString([In] ref Guid key, out IntPtr value, out uint length);
    [PreserveSig] new int GetBlobSize([In] ref Guid key, out uint size);
    [PreserveSig] new int GetBlob([In] ref Guid key, IntPtr buffer, uint size, out uint written);
    [PreserveSig] new int GetAllocatedBlob([In] ref Guid key, out IntPtr buffer, out uint size);
    [PreserveSig] new int GetUnknown([In] ref Guid key, [In] ref Guid iid, out IntPtr value);
    [PreserveSig] new int SetItem([In] ref Guid key, IntPtr value);
    [PreserveSig] new int DeleteItem([In] ref Guid key);
    [PreserveSig] new int DeleteAllItems();
    [PreserveSig] new int SetUINT32([In] ref Guid key, uint value);
    [PreserveSig] new int SetUINT64([In] ref Guid key, ulong value);
    [PreserveSig] new int SetDouble([In] ref Guid key, double value);
    [PreserveSig] new int SetGUID([In] ref Guid key, [In] ref Guid value);
    [PreserveSig] new int SetString([In] ref Guid key, [MarshalAs(UnmanagedType.LPWStr)] string value);
    [PreserveSig] new int SetBlob([In] ref Guid key, IntPtr buffer, uint size);
    [PreserveSig] new int SetUnknown([In] ref Guid key, IntPtr value);
    [PreserveSig] new int LockStore();
    [PreserveSig] new int UnlockStore();
    [PreserveSig] new int GetCount(out uint count);
    [PreserveSig] new int GetItemByIndex(uint index, out Guid key, IntPtr value);
    [PreserveSig] new int CopyAllItems(IMFAttributes destination);

    // IMFSample
    [PreserveSig] int GetSampleFlags(out uint flags);
    [PreserveSig] int SetSampleFlags(uint flags);
    [PreserveSig] int GetSampleTime(out long time);
    [PreserveSig] int SetSampleTime(long time);
    [PreserveSig] int GetSampleDuration(out long duration);
    [PreserveSig] int SetSampleDuration(long duration);
    [PreserveSig] int GetBufferCount(out uint count);
    [PreserveSig] int GetBufferByIndex(uint index, out IMFMediaBuffer buffer);
    [PreserveSig] int ConvertToContiguousBuffer(out IMFMediaBuffer buffer);
    [PreserveSig] int AddBuffer(IMFMediaBuffer buffer);
    [PreserveSig] int RemoveBufferByIndex(uint index);
    [PreserveSig] int RemoveAllBuffers();
    [PreserveSig] int GetTotalLength(out uint length);
    [PreserveSig] int CopyToBuffer(IMFMediaBuffer buffer);
}

[ComImport, Guid("045FA593-8799-42B8-BC8D-8968C6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMFMediaBuffer
{
    [PreserveSig] int Lock(out IntPtr buffer, out uint maxLength, out uint currentLength);
    [PreserveSig] int Unlock();
    [PreserveSig] int GetCurrentLength(out uint length);
    [PreserveSig] int SetCurrentLength(uint length);
    [PreserveSig] int GetMaxLength(out uint length);
}

[ComImport, Guid("7DC9D5F9-9ED9-44EC-9BBF-0600BB589FBB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMF2DBuffer
{
    [PreserveSig] int Lock2D(out IntPtr scanline0, out int pitch);
    [PreserveSig] int Unlock2D();
    [PreserveSig] int GetScanline0AndPitch(out IntPtr scanline0, out int pitch);
    [PreserveSig] int IsContiguousFormat(out int contiguous);
    [PreserveSig] int GetContiguousLength(out uint length);
    [PreserveSig] int ContiguousCopyTo(IntPtr destination, uint size);
    [PreserveSig] int ContiguousCopyFrom(IntPtr source, uint size);
}

[ComImport, Guid("BF94C121-5B05-4E6F-8000-BA598961414D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMFTransform
{
    [PreserveSig] int GetStreamLimits(out uint inputMin, out uint inputMax, out uint outputMin, out uint outputMax);
    [PreserveSig] int GetStreamCount(out uint inputs, out uint outputs);
    [PreserveSig] int GetStreamIDs(uint inputSize, IntPtr inputIds, uint outputSize, IntPtr outputIds);
    [PreserveSig] int GetInputStreamInfo(uint id, out MFT_INPUT_STREAM_INFO info);
    [PreserveSig] int GetOutputStreamInfo(uint id, out MFT_OUTPUT_STREAM_INFO info);
    [PreserveSig] int GetAttributes(out IMFAttributes attributes);
    [PreserveSig] int GetInputStreamAttributes(uint id, out IMFAttributes attributes);
    [PreserveSig] int GetOutputStreamAttributes(uint id, out IMFAttributes attributes);
    [PreserveSig] int DeleteInputStream(uint id);
    [PreserveSig] int AddInputStreams(uint count, IntPtr ids);
    [PreserveSig] int GetInputAvailableType(uint id, uint index, out IMFMediaType type);
    [PreserveSig] int GetOutputAvailableType(uint id, uint index, out IMFMediaType type);
    [PreserveSig] int SetInputType(uint id, IMFMediaType? type, uint flags);
    [PreserveSig] int SetOutputType(uint id, IMFMediaType? type, uint flags);
    [PreserveSig] int GetInputCurrentType(uint id, out IMFMediaType type);
    [PreserveSig] int GetOutputCurrentType(uint id, out IMFMediaType type);
    [PreserveSig] int GetInputStatus(uint id, out uint flags);
    [PreserveSig] int GetOutputStatus(out uint flags);
    [PreserveSig] int SetOutputBounds(long lower, long upper);
    [PreserveSig] int ProcessEvent(uint id, IntPtr mediaEvent);
    [PreserveSig] int ProcessMessage(int message, IntPtr param);
    [PreserveSig] int ProcessInput(uint id, IMFSample sample, uint flags);
    [PreserveSig] int ProcessOutput(uint flags, uint count, [In, Out] MFT_OUTPUT_DATA_BUFFER[] buffers, out uint status);
}

[ComImport, Guid("901DB4C7-31CE-41A2-85DC-8FA0BF41B8DA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ICodecAPI
{
    [PreserveSig] int IsSupported([In] ref Guid api);
    [PreserveSig] int IsModifiable([In] ref Guid api);
    [PreserveSig] int GetParameterRange([In] ref Guid api, IntPtr min, IntPtr max, IntPtr step);
    [PreserveSig] int GetParameterValues([In] ref Guid api, out IntPtr values, out uint count);
    [PreserveSig] int GetDefaultValue([In] ref Guid api, IntPtr value);
    [PreserveSig] int GetValue([In] ref Guid api, IntPtr value);
    [PreserveSig] int SetValue([In] ref Guid api, [In] ref Variant value);
    [PreserveSig] int RegisterForEvent([In] ref Guid api, IntPtr userData);
    [PreserveSig] int UnregisterForEvent([In] ref Guid api);
    [PreserveSig] int SetAllDefaults();
    [PreserveSig] int SetValueWithNotify([In] ref Guid api, IntPtr value, out IntPtr changed, out uint changedCount);
    [PreserveSig] int SetAllDefaultsWithNotify(out IntPtr changed, out uint changedCount);
    [PreserveSig] int GetAllSettings(IntPtr stream);
    [PreserveSig] int SetAllSettings(IntPtr stream);
    [PreserveSig] int SetAllSettingsWithNotify(IntPtr stream, out IntPtr changed, out uint changedCount);
}
