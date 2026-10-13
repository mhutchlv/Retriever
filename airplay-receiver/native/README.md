# Native components

## playfair (required)

`playfair/` is the FairPlay key-decryption helper vendored verbatim from
[UxPlay](https://github.com/FDH2/UxPlay) `lib/playfair` at commit
`ec203121355220dd90278a369eeabb0b8ba4f14a` (GPL-3.0, see `playfair/LICENSE.md`).
It is a reverse-engineered black box with large constant tables; the receiver
calls exactly one function, `playfair_decrypt()`, to turn the FairPlay-wrapped
AES key sent by the iPhone into the 16-byte session key.

The managed code loads it as `playfair.dll` (Windows) or `libplayfair.so`
(Linux, used by the test suite).

### Prebuilt binary

`prebuilt/win-x64/playfair.dll` was cross-compiled from these exact sources with
mingw-w64 so that `dotnet build` works out of the box:

```sh
x86_64-w64-mingw32-gcc -O2 -s -shared -static-libgcc -o playfair.dll \
  playfair.c omg_hax.c sap_hash.c modified_md5.c hand_garble.c
```

It depends only on `kernel32.dll` and `msvcrt.dll`. Rebuild it yourself if you
prefer not to trust a committed binary.

### Rebuilding with Visual Studio (CMake)

```powershell
cd native\playfair
cmake -B build -A x64
cmake --build build --config Release
copy build\Release\playfair.dll ..\prebuilt\win-x64\playfair.dll
```

### Rebuilding with MSYS2 / mingw-w64 on Windows

```sh
gcc -O2 -s -shared -o ../prebuilt/win-x64/playfair.dll playfair.c omg_hax.c sap_hash.c modified_md5.c hand_garble.c
```

## fdk-aac (optional, audio only)

Screen mirroring sends audio as AAC-ELD, which Windows Media Foundation cannot
decode. If `libfdk-aac-2.dll` (from MSYS2 `mingw-w64-x86_64-fdk-aac` or a build
of https://github.com/mstorsjo/fdk-aac) is placed next to the executable, the
app decodes and plays mirrored audio. Without it, video still works and the
status bar reports that audio is unavailable.
