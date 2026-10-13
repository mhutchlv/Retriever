# Architecture

The receiver implements the AirPlay screen-mirroring protocol that iOS uses when it talks
to a third-party receiver (the "legacy pairing" flow from iOS 9 onwards, still used by iOS
17/18/26 against receivers that advertise feature bit 27). It is the same protocol as
UxPlay and RPiPlay; UxPlay was the reference for every constant in this code.

```
 iPhone / iPad                               Windows PC
 ─────────────                               ──────────────────────────────────────────────
 mDNS query  ───────────────────────────►    MdnsResponder        (UDP 5353, multicast)
             ◄───────────────────────────    _airplay._tcp + _raop._tcp + A record
 RTSP/1.0 control connection ────────────►   RtspServer -> RequestRouter      (TCP 7000)
   GET /info, pair-setup, pair-verify,         PairingSession (Ed25519 / X25519 / AES-CTR)
   fp-setup x2, SETUP x2, RECORD,              FairPlaySession + playfair (native)
   SET_PARAMETER, /feedback, TEARDOWN          AirPlayKeys (SHA-512 derivations)
 video stream ───────────────────────────►   MirrorStreamReceiver           (TCP 7100)
   128-byte headers, AES-128-CTR payload       -> Annex B access units -> events
 audio RTP ──────────────────────────────►   AudioStreamReceiver     (UDP 6000 / 6001)
   AES-128-CBC per packet, resend/sync         -> AAC-ELD frames -> events
 timing      ◄──────────────────────────►    NtpTimingClient                (UDP 7011)
```

## Projects

| Project | Target | Role |
|---|---|---|
| `src/AirPlay.Core` | net8.0 | Everything above the dotted line: discovery, control protocol, crypto, stream receivers. No UI, no Windows dependencies, runs on Linux/macOS for tests. |
| `src/AirPlay.Windows` | net8.0-windows (WPF) | The desktop app: window, tray, settings, Media Foundation decoder, WASAPI audio. |
| `src/AirPlay.Host` | net8.0 | Headless console receiver for debugging and for capturing a raw `.h264` stream on any OS. |
| `tests/AirPlay.Core.Tests` | net8.0 | xunit suite including a simulated iPhone that runs the whole session over loopback. |
| `native/playfair` | C | FairPlay key decryption (vendored from UxPlay). The only native code. |

## 1. Discovery (`AirPlay.Core/Dns`)

`MdnsResponder` is a small RFC 6762/6763 responder. It binds UDP 5353 with
`SO_REUSEADDR` (so it coexists with the Windows built-in mDNS service, Bonjour and
Avahi), joins `224.0.0.251` on every usable IPv4 interface (plus `ff02::fb` for
queries that arrive over IPv6) and answers only for its own names:

* `_airplay._tcp.local` PTR -> `<name>._airplay._tcp.local` with SRV (port 7000),
  TXT (`deviceid`, `features`, `pw`, `flags`, `model`, `pk`, `pi`, `srcvers`, `vv`)
  and an A record for `airplay-<mac>.local`.
* `_raop._tcp.local` PTR -> `<MAC>@<name>._raop._tcp.local` with the RAOP TXT set
  (`cn`, `et`, `ft`, `am`, `pw`, `sf`, `tp`, `pk`, ...).
* `_services._dns-sd._udp.local` enumeration, unicast-response (QU) and legacy
  unicast queries, known-answer suppression.

Three unsolicited announcements are sent at start (cache-flush set on the unique
records), a goodbye (TTL 0) at stop, and interfaces are re-scanned when the
network changes. Name conflicts are not probed for.

The feature bits are UxPlay's `0x5A7FFEE6,0x0`; bit 27 keeps the legacy pairing flow,
bit 42 is added when HEVC is enabled. Replies for a query received on interface X
carry X's IPv4 address, so multi-homed PCs (Wi-Fi + Ethernet + USB tethering) work.

## 2. Control connection (`Rtsp`, `Session`)

iOS opens one TCP connection to port 7000 and speaks RTSP/1.0 framing (also used for
the `GET /info`, `POST /pair-*`, `/fp-setup` and `/feedback` requests). `RtspServer`
parses requests incrementally; `RequestRouter` implements the handlers:

| Request | What happens |
|---|---|
| `GET /info` | Binary plist with `txtAirPlay` (when asked via `qualifier`) or the full device description (`features`, `pk`, `displays`, `audioFormats`, ...). |
| `POST /pair-setup` | Returns the receiver's Ed25519 public key (persisted in `identity.key`). |
| `POST /pair-verify` (x2) | X25519 ECDH, Ed25519 signatures encrypted with AES-128-CTR keyed by SHA-512("Pair-Verify-AES-Key"/"-IV" + secret). Produces the shared secret. |
| `POST /fp-setup` (x2) | FairPlay v3: a fixed 142-byte reply per mode, then an echo of the 164-byte message that is kept for key decryption. |
| `SETUP` #1 (`ekey`, `eiv`) | Optional Digest password check (401 + `WWW-Authenticate: Digest realm="raop"`), `playfair_decrypt(ekey)` -> FairPlay key, shared stream key = SHA-512(fpKey ‖ ecdhSecret)[0..16], NTP timing client started. Replies `eventPort: 0`, `timingPort`. |
| `SETUP` #2 (`streams`) | type 110 -> `MirrorStreamReceiver` (replies `dataPort`); type 96 -> `AudioStreamReceiver` (replies `dataPort`, `controlPort`). |
| `RECORD` | `Audio-Latency: 11025`. |
| `GET_PARAMETER` / `SET_PARAMETER` | Volume (dB), progress, artwork, DMAP metadata. |
| `POST /feedback` | Heartbeat every 2 s; a 30 s silence drops the session. |
| `TEARDOWN` | Per stream (`streams: [{type}]`) or the whole session. |
| HTTP/1.1 requests | AirPlay video (URL playback, HLS) is declined with 501. |

One device mirrors at a time. A second device either takes over (default) or gets
`409 Conflict`.

## 3. Video pipeline

`MirrorStreamReceiver` accepts one TCP connection on the mirror data port. Each packet
has a 128-byte header: little-endian payload size, type byte (`0` video, `1` codec
data, `2` heartbeat, `5` stream report), a sub-type (`0x10` marks IDR packets),
an option byte (`0x56`/`0x5e` = client paused, `0x16`/`0x1e` = running) and an
NTP timestamp.

* Codec packets carry an `avcC` record (or an `hvcC` layout for HEVC) and the picture
  size as floats. SPS/PPS are converted to Annex B and prepended to the next video
  packet, which iOS always sends as an IDR with the same timestamp.
* Video payloads are AES-128-CTR encrypted with key/IV = SHA-512("AirPlayStreamKey"/"IV"
  + streamConnectionID ‖ sharedKey)[0..16]. The keystream is continuous across packets.
  NAL units are 4-byte-length prefixed and rewritten to start codes in place.
* Frames are published as `VideoFrame` events (Annex B, keyframe flag).

In the Windows app `VideoPipeline` runs a decode thread fed by a bounded queue (when the
UI falls behind, the oldest frames are dropped and decoding resumes at the next
keyframe). `MfVideoDecoder` wraps the Microsoft H.264 decoder MFT (`CLSID_CMSH264DecoderMFT`;
`CLSID_CMSHEVCDecoderMFT` for HEVC) through hand-written COM interop with
`MF_LOW_LATENCY` and `CODECAPI_AVLowLatencyMode` set so pictures come out as soon as
they are decoded. The MFT uses DXVA hardware decoding when a GPU driver provides it and
multi-threaded software decoding otherwise. Output is NV12; `Nv12Converter` converts the
visible aperture to BGRA (BT.709, parallelised over rows) into a frame that the UI thread
copies into a `WriteableBitmap` at render priority. Only the newest frame is presented.

## 4. Audio pipeline

`AudioStreamReceiver` binds the data and control UDP ports. Data packets are 12-byte RTP
headers plus an AES-128-CBC payload (whole blocks only, IV reset per packet, key =
shared stream key, IV = `eiv`). A reorder buffer handles out-of-order and duplicated
packets (AAC-ELD frames are sent several times) and asks for retransmission over the
control port; sync packets (`0x54`) map RTP time to client NTP time.

Mirroring audio is AAC-ELD, 44.1 kHz stereo, 480 samples per frame. Windows has no
AAC-ELD decoder, so `AudioPipeline` loads `libfdk-aac-2.dll` when present (P/Invoke in
`FdkAac.cs`, ASC `F8 E8 50 00`) and plays through NAudio's shared-mode WASAPI output with
the AirPlay volume applied. Without the DLL the app reports "audio unavailable".

## 5. Timing

`NtpTimingClient` sends 32-byte timing requests to the client's timing port (a burst at
start, then every 3 s) and keeps the lowest-delay offset estimate. The UI shows that the
clock is synchronised; the headless host prints an estimated capture-to-receive latency.

## 6. UI (`AirPlay.Windows`)

WPF window with the video `Image`, a status bar (device, codec, resolution, fps, audio
state), a centered overlay with instructions, a context menu and shortcuts (F11
fullscreen, Ctrl+T always on top, Ctrl+S screenshot, Ctrl+R raw stream recording,
Ctrl+, settings). Settings are JSON in `%APPDATA%\AirPlayReceiver`; the identity key and
`receiver.log` live next to it. A WinForms `NotifyIcon` provides the tray, `StartupHelper`
writes the `Run` registry value, `FirewallHelper` adds a program rule with `netsh` through
a UAC prompt.

## Where the latency goes

Typical glass-to-glass latency with this design is the iPhone's encoder (~50-80 ms) plus
network plus decode (a few ms with DXVA) plus one display frame. Nothing in the receiver
buffers deliberately: the TCP reader hands each access unit straight to the decoder, the
decoder is in low-latency mode, and the presenter drops stale frames.
