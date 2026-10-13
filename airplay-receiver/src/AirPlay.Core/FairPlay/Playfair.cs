using System.Reflection;
using System.Runtime.InteropServices;

namespace AirPlay.FairPlay;

/// <summary>Decrypts the FairPlay-wrapped AES key from SETUP using the 164-byte fp-setup message.</summary>
public interface IFairPlayDecryptor
{
    byte[] DecryptKey(ReadOnlySpan<byte> fpSetupMessage, ReadOnlySpan<byte> encryptedKey);
}

/// <summary>
/// P/Invoke binding to the vendored "playfair" library (native/playfair). It is loaded as
/// playfair.dll on Windows and libplayfair.so / libplayfair.dylib elsewhere, from the
/// application directory, or from the path in the PLAYFAIR_LIBRARY environment variable.
/// </summary>
public sealed unsafe class NativePlayfair : IFairPlayDecryptor
{
    public const string LibraryName = "playfair";

    private static readonly object InitLock = new();
    private static bool _resolverInstalled;

    public NativePlayfair()
    {
        EnsureResolver();
    }

    public static bool IsAvailable
    {
        get
        {
            try
            {
                EnsureResolver();
                return Resolve(LibraryName, typeof(NativePlayfair).Assembly, null) != IntPtr.Zero
                       || NativeLibrary.TryLoad(LibraryName, typeof(NativePlayfair).Assembly, DllImportSearchPath.AssemblyDirectory | DllImportSearchPath.ApplicationDirectory, out var handle) && handle != IntPtr.Zero;
            }
            catch
            {
                return false;
            }
        }
    }

    public byte[] DecryptKey(ReadOnlySpan<byte> fpSetupMessage, ReadOnlySpan<byte> encryptedKey)
    {
        if (fpSetupMessage.Length != 164)
        {
            throw new ArgumentException("fp-setup message must be 164 bytes.");
        }

        if (encryptedKey.Length != 72)
        {
            throw new ArgumentException("Encrypted key must be 72 bytes.");
        }

        var output = new byte[16];
        fixed (byte* msg = fpSetupMessage)
        fixed (byte* key = encryptedKey)
        fixed (byte* outp = output)
        {
            playfair_decrypt(msg, key, outp);
        }

        return output;
    }

    [DllImport(LibraryName, EntryPoint = "playfair_decrypt", CallingConvention = CallingConvention.Cdecl)]
    private static extern void playfair_decrypt(byte* message3, byte* cipherText, byte* keyOut);

    private static void EnsureResolver()
    {
        lock (InitLock)
        {
            if (_resolverInstalled)
            {
                return;
            }

            NativeLibrary.SetDllImportResolver(typeof(NativePlayfair).Assembly, Resolve);
            _resolverInstalled = true;
        }
    }

    private static IntPtr Resolve(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (libraryName != LibraryName)
        {
            return IntPtr.Zero;
        }

        foreach (var candidate in Candidates())
        {
            if (File.Exists(candidate) && NativeLibrary.TryLoad(candidate, out var handle))
            {
                return handle;
            }
        }

        return IntPtr.Zero; // fall back to default probing
    }

    private static IEnumerable<string> Candidates()
    {
        var env = Environment.GetEnvironmentVariable("PLAYFAIR_LIBRARY");
        if (!string.IsNullOrEmpty(env))
        {
            yield return env;
        }

        string[] names = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? new[] { "playfair.dll" }
            : RuntimeInformation.IsOSPlatform(OSPlatform.OSX)
                ? new[] { "libplayfair.dylib", "playfair.dylib" }
                : new[] { "libplayfair.so", "playfair.so" };

        var dirs = new[]
        {
            AppContext.BaseDirectory,
            Path.GetDirectoryName(typeof(NativePlayfair).Assembly.Location) ?? AppContext.BaseDirectory,
            Environment.CurrentDirectory,
        };

        foreach (var dir in dirs.Distinct())
        {
            foreach (var name in names)
            {
                yield return Path.Combine(dir, name);
                yield return Path.Combine(dir, "runtimes", RuntimeInformation.RuntimeIdentifier, "native", name);
            }
        }
    }
}
