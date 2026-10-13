# AirPlay Receiver for Windows

Turns a Windows 10/11 PC into an AirPlay screen-mirroring receiver. The PC shows up in the
iPhone's or iPad's Control Center under **Screen Mirroring**, with no app needed on the
device, and the mirrored screen appears in a resizable (or fullscreen) window.

* Discovery over mDNS/Bonjour without installing Apple's Bonjour service
* Native AirPlay pairing and FairPlay key exchange (iOS 9 through iOS 26 use this flow
  with third-party receivers)
* H.264 decoding through Windows Media Foundation (DXVA hardware decoding when available),
  low-latency mode, experimental HEVC
* Mirrored audio (AAC-ELD) when `libfdk-aac-2.dll` is present
* Custom receiver name, optional password, always on top, aspect modes, fullscreen,
  screenshots, raw-stream recording, system tray, start with Windows, firewall helper
* A headless cross-platform host for debugging and a test suite with a simulated iPhone

Built on the protocol work of [UxPlay](https://github.com/FDH2/UxPlay) and RPiPlay; the
FairPlay component is UxPlay's `playfair` library, vendored as the only native code.
Licensed GPL-3.0 (see `LICENSE`).

> **Status.** The protocol core is verified end-to-end by tests that drive it the way an
> iPhone does, over loopback, on Linux. The Windows app compiles but was written without
> access to a Windows machine or an iOS device, so the Media Foundation decoder path, the
> WPF presentation, the tray icon and the audio output have **not been exercised against
> real hardware yet**. Expect to iterate: `receiver.log` in `%APPDATA%\AirPlayReceiver`
> and the headless host are the first things to look at when something does not work.

## Requirements

* Windows 10 version 1809 or later, or Windows 11, x64
* [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) to build (the published
  app is self-contained and needs no runtime on other PCs)
* The iPhone/iPad and the PC on the same local network (same subnet, no client/AP isolation)
* Optional: `libfdk-aac-2.dll` next to the executable for audio (see `native/README.md`)
* Optional: "HEVC Video Extensions" from the Microsoft Store if you turn on HEVC

## Quick start

```powershell
git clone <this repository>
cd Retriever\airplay-receiver
dotnet run --project src\AirPlay.Windows
```

Then on the iPhone: Control Center → Screen Mirroring → pick the PC's name (your machine
name by default). The first time, Windows Defender Firewall asks whether to allow the app:
allow it on **private** networks. If no prompt appears or you dismissed it, use
**Settings → Add firewall rule** inside the app (one UAC prompt), or run as administrator:

```powershell
netsh advfirewall firewall add rule name="AirPlay Receiver" dir=in action=allow program="<full path>\AirPlayReceiver.exe" enable=yes profile=private,domain
```

### Window controls

| Action | How |
|---|---|
| Fullscreen | F11, Alt+Enter or double-click (Esc leaves) |
| Always on top | Ctrl+T or the context menu |
| Aspect ratio | Context menu: Fit (letterbox), Fill (crop), Stretch |
| Screenshot (PNG to Pictures\AirPlay Receiver) | Ctrl+S |
| Record the raw H.264 stream (Videos\AirPlay Receiver\*.h264) | Ctrl+R |
| Settings (name, password, startup, tray, audio, HEVC) | Ctrl+, |
| Minimize to tray / exit | Minimize or close the window; Exit is in the menus |

A recorded `.h264` file plays in VLC or converts losslessly with
`ffmpeg -r 60 -i "file.h264" -c copy file.mp4`. OBS users can add the receiver window as a
Window Capture source; a virtual-camera output is not built in.

## Building

### The app

```powershell
cd airplay-receiver
dotnet build AirPlayReceiver.sln -c Release
dotnet publish src\AirPlay.Windows\AirPlay.Windows.csproj -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -o publish
```

`publish\AirPlayReceiver.exe` plus `playfair.dll` (copied automatically) is the whole
deployment. The GitHub Actions workflow `.github/workflows/airplay-receiver.yml` produces
the same package as a downloadable artifact on every push.

### The native FairPlay helper

`native/prebuilt/win-x64/playfair.dll` is committed so a plain `dotnet build` works. It is
built from the vendored sources in `native/playfair` with mingw-w64; `native/README.md`
has the exact command and a CMake recipe for Visual Studio if you want to rebuild it.

### Tests and the headless host (any OS)

```sh
cd airplay-receiver
dotnet test tests/AirPlay.Core.Tests          # needs a C compiler for libplayfair
dotnet run --project src/AirPlay.Host -- --name "Test PC" --dump-h264 capture.h264 -v
```

The host advertises the receiver, accepts a mirroring session and writes the decrypted
H.264 stream to a file (`ffplay -f h264 capture.h264` plays it). It is the quickest way to
separate "the protocol works" from "the decoder/UI works" on a Windows machine, and it runs
on Linux and macOS as well.

## Settings and files

`%APPDATA%\AirPlayReceiver\settings.json` holds every option, including the ports
(RTSP 7000, video 7100, audio 6000/6001, timing 7011) in case something else uses them.
`identity.key` is the receiver's Ed25519 identity (the `pk` the device sees; keep it so the
device does not see a "new" receiver after every restart). `receiver.log` is rewritten on
each start; turn on **Verbose log** in Settings for protocol-level detail.

## Lower latency over USB

AirPlay has no USB transport, but the iPhone's **Personal Hotspot over USB** creates a
private network between the phone and the PC (install Apple's USB driver via iTunes or the
Apple Devices app, then enable Personal Hotspot and connect the cable). The receiver
advertises on every interface, so the PC appears in Screen Mirroring over that link with
the Wi-Fi jitter removed. Keep Wi-Fi on the phone enabled, or the hotspot interface may not
route multicast.

## Known limitations

* **Reverse control (touch/keyboard back to the phone) is not possible.** AirPlay mirroring
  is one-way; iOS exposes no input channel to a receiver. Doing it needs a jailbreak or a
  companion app on the device, which this project deliberately avoids. The protocol does
  carry the AirPlay volume and media-remote hints, which are honoured for audio.
* **Audio needs fdk-aac.** Screen mirroring sends AAC-ELD, which Media Foundation cannot
  decode. Without `libfdk-aac-2.dll` the video works and the status bar says audio is
  unavailable. AirPlay *audio-only* streaming (ALAC from the Music app) is received but not
  decoded.
* **AirPlay video (URL playback from Photos, YouTube, HLS) is declined** with 501; only
  screen mirroring and the mirrored audio are implemented.
* **HEVC is experimental.** iOS only sends HEVC when feature bit 42 is advertised; the app
  then needs the Microsoft HEVC decoder (Store extension). The `hvcC` parsing follows
  UxPlay but has not been verified here.
* **One device at a time.** A second device replaces the first (configurable) instead of
  mirroring side by side.
* **iOS compatibility.** iOS 9 through iOS 26 and macOS use the legacy pairing flow when the
  receiver advertises feature bit 27, which this receiver does. Apple can change the
  protocol in any release; UxPlay's issue tracker is the best early warning. Devices
  enrolled in MDM with AirPlay restrictions, or networks with multicast filtering, will not
  see the receiver.
* **mDNS name conflicts are not resolved.** If another receiver uses the same name, change
  the name in Settings.
* **Rendering is CPU-based** (NV12 → BGRA → `WriteableBitmap`). It is fine for 1080p60 on
  a modern PC; a Direct3D swap-chain presenter is the natural next step for 4K.

## Repository layout

```
airplay-receiver/
  src/AirPlay.Core      protocol core (mDNS, RTSP, pairing, FairPlay, streams)
  src/AirPlay.Windows   WPF app (decoder, presenter, audio, tray, settings)
  src/AirPlay.Host      headless console receiver
  tests/                xunit suite with a simulated iPhone
  native/playfair       vendored FairPlay sources (+ prebuilt win-x64 DLL)
  docs/ARCHITECTURE.md  how the pieces fit, packet formats, key derivations
```
