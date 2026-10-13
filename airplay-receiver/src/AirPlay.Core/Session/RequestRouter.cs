using System.Globalization;
using System.Text;
using AirPlay.Crypto;
using AirPlay.Dns;
using AirPlay.Pairing;
using AirPlay.Plist;
using AirPlay.Rtsp;
using AirPlay.Streams;

namespace AirPlay.Session;

/// <summary>Maps the RTSP/HTTP requests iOS sends during a mirroring session to protocol actions.</summary>
internal sealed class RequestRouter
{
    private const string BinaryPlistType = "application/x-apple-binary-plist";
    private const string OctetStream = "application/octet-stream";

    private readonly AirPlayReceiver _receiver;
    private readonly Log _log;

    public RequestRouter(AirPlayReceiver receiver, Log log)
    {
        _receiver = receiver;
        _log = log;
    }

    private ReceiverOptions Options => _receiver.Options;

    public async Task<RtspResponse?> HandleAsync(RtspConnection rtsp, RtspRequest request)
    {
        var conn = (AirPlayConnection)rtsp.State!;
        var response = new RtspResponse(request.Protocol);
        if (request.CSeq != null && request.Method != "RECORD")
        {
            response.AddHeader("Audio-Jack-Status", "connected; type=digital");
        }

        if (_log.IsEnabled(LogLevel.Debug))
        {
            _log.Debug($"#{rtsp.Id} {request.Method} {request.Uri} {request.Protocol} body={request.Body.Length} ct={request.ContentType}");
        }

        try
        {
            if (request.Protocol.StartsWith("HTTP/", StringComparison.OrdinalIgnoreCase) && request.CSeq == null)
            {
                // AirPlay video (HLS / URL playback) uses plain HTTP; this receiver only does screen mirroring and audio.
                _log.Info($"Ignoring AirPlay video request {request.Method} {request.Path} (not supported).");
                response.WithStatus(501, "Not Implemented");
            }
            else
            {
                switch (request.Method)
                {
                    case "GET" when request.Path == "/info":
                        HandleInfo(request, response);
                        break;
                    case "POST" when request.Path == "/pair-setup":
                        HandlePairSetup(conn, request, response);
                        break;
                    case "POST" when request.Path == "/pair-verify":
                        HandlePairVerify(conn, request, response);
                        break;
                    case "POST" when request.Path == "/fp-setup":
                        HandleFpSetup(conn, request, response);
                        break;
                    case "POST" when request.Path == "/feedback":
                        _receiver.TouchSession(conn);
                        break;
                    case "POST" when request.Path == "/audioMode":
                        break;
                    case "OPTIONS":
                        response.AddHeader("Public", "SETUP, RECORD, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER");
                        break;
                    case "SETUP":
                        await HandleSetupAsync(conn, request, response).ConfigureAwait(false);
                        break;
                    case "RECORD":
                    {
                        var latency = (long)Options.AudioLatencyMicros * 44100 / 1_000_000;
                        response.AddHeader("Audio-Latency", latency.ToString(CultureInfo.InvariantCulture));
                        response.AddHeader("Audio-Jack-Status", "connected; type=analog");
                        break;
                    }
                    case "GET_PARAMETER":
                        HandleGetParameter(conn, request, response);
                        break;
                    case "SET_PARAMETER":
                        HandleSetParameter(conn, request, response);
                        break;
                    case "FLUSH":
                        break;
                    case "TEARDOWN":
                        HandleTeardown(conn, request, response);
                        break;
                    default:
                        _log.Info($"Unhandled request {request.Method} {request.Path}; answering 200.");
                        break;
                }
            }
        }
        catch (NotSupportedException ex)
        {
            _log.Error($"{request.Method} {request.Path}: {ex.Message}");
            response.WithStatus(501, "Not Implemented");
        }
        catch (Exception ex)
        {
            _log.Error($"{request.Method} {request.Path} failed: {ex}");
            response.WithStatus(500, "Internal Server Error");
        }

        response.AddHeader("Server", "AirTunes/" + Options.SourceVersion);
        if (request.CSeq != null)
        {
            response.AddHeader("CSeq", request.CSeq);
        }

        return response;
    }

    // ---------------------------------------------------------------- /info

    private void HandleInfo(RtspRequest request, RtspResponse response)
    {
        var result = new PlistDict();
        var hasBody = request.ContentType != null && request.ContentType.Contains("binary-plist", StringComparison.OrdinalIgnoreCase);
        if (hasBody && request.Body.Length > 0)
        {
            var qualifiers = BinaryPlist.ParseDict(request.Body).GetArray("qualifier");
            if (qualifiers != null)
            {
                foreach (var q in qualifiers)
                {
                    if (q is string s && s == "txtAirPlay")
                    {
                        result["txtAirPlay"] = _receiver.AirPlayService.TxtRecordBytes();
                    }
                    else if (q is string r && r == "txtRAOP")
                    {
                        result["txtRAOP"] = _receiver.RaopService.TxtRecordBytes();
                    }
                }
            }
        }

        if (!hasBody)
        {
            var mac = Hex.MacColon(_receiver.MacAddress);
            result["deviceID"] = mac;
            result["macAddress"] = mac;
            result["pk"] = _receiver.Identity.PublicKey.ToArray();
            result["features"] = unchecked((long)Options.Features);
            result["name"] = Options.Name;
            result["pi"] = Options.PairingIdentifier;
            result["vv"] = 2L;
            result["statusFlags"] = 68L;
            result["keepAliveLowPower"] = 1L;
            result["sourceVersion"] = Options.SourceVersion;
            result["keepAliveSendStatsAsBody"] = true;
            result["model"] = Options.Model;
            result["initialVolume"] = 0.0;
            result["audioLatencies"] = new List<object?>
            {
                new PlistDict { ["type"] = 100L, ["audioType"] = "default", ["inputLatencyMicros"] = 0L, ["outputLatencyMicros"] = false },
                new PlistDict { ["type"] = 101L, ["audioType"] = "default", ["inputLatencyMicros"] = 0L, ["outputLatencyMicros"] = false },
            };
            result["audioFormats"] = new List<object?>
            {
                new PlistDict { ["type"] = 100L, ["audioInputFormats"] = 0x3fffffcL, ["audioOutputFormats"] = 0x3fffffcL },
                new PlistDict { ["type"] = 101L, ["audioInputFormats"] = 0x3fffffcL, ["audioOutputFormats"] = 0x3fffffcL },
            };
            result["displays"] = new List<object?>
            {
                new PlistDict
                {
                    ["uuid"] = "e0ff8a27-6738-3d56-8a16-cc53aacee925",
                    ["widthPhysical"] = 0L,
                    ["heightPhysical"] = 0L,
                    ["width"] = (long)Options.DisplayWidth,
                    ["height"] = (long)Options.DisplayHeight,
                    ["widthPixels"] = (long)Options.DisplayWidth,
                    ["heightPixels"] = (long)Options.DisplayHeight,
                    ["rotation"] = false,
                    ["refreshRate"] = 1.0 / Math.Max(1, Options.RefreshRate),
                    ["maxFPS"] = (long)Options.MaxFps,
                    ["overscanned"] = Options.Overscanned,
                    ["features"] = 14L,
                },
            };
        }

        response.WithBody(BinaryPlist.Write(result), BinaryPlistType);
    }

    // ---------------------------------------------------------------- pairing

    private void HandlePairSetup(AirPlayConnection conn, RtspRequest request, RtspResponse response)
    {
        if (request.Body.Length != 32)
        {
            _log.Warn($"pair-setup with {request.Body.Length} bytes (expected 32).");
            response.WithStatus(400, "Bad Request");
            return;
        }

        var ours = conn.Pairing.Setup(request.Body);
        response.WithBody(ours, OctetStream);
    }

    private void HandlePairVerify(AirPlayConnection conn, RtspRequest request, RtspResponse response)
    {
        var body = request.Body;
        if (body.Length < 4)
        {
            response.WithStatus(400, "Bad Request");
            return;
        }

        if (body[0] == 1)
        {
            if (conn.Pairing.Status == PairingStatus.Initial)
            {
                // Some clients skip pair-setup; UxPlay tolerates this only in PIN mode. Be lenient: it only affects key hashing.
                _log.Debug("pair-verify without preceding pair-setup.");
            }

            var reply = conn.Pairing.VerifyStep1(body);
            response.WithBody(reply, OctetStream);
        }
        else if (body[0] == 0)
        {
            if (!conn.Pairing.VerifyStep2(body))
            {
                _log.Warn("pair-verify signature check failed; closing connection.");
                response.WithStatus(401, "Unauthorized");
                response.CloseConnection = true;
                return;
            }

            _log.Debug("pair-verify complete.");
            response.ContentType = OctetStream;
        }
        else
        {
            response.WithStatus(400, "Bad Request");
        }
    }

    private void HandleFpSetup(AirPlayConnection conn, RtspRequest request, RtspResponse response)
    {
        var body = request.Body;
        if (body.Length == FairPlay.FairPlaySession.SetupRequestLength)
        {
            response.WithBody(conn.FairPlay.Setup(body), OctetStream);
        }
        else if (body.Length == FairPlay.FairPlaySession.HandshakeRequestLength)
        {
            response.WithBody(conn.FairPlay.Handshake(body), OctetStream);
        }
        else
        {
            _log.Warn($"fp-setup with unexpected length {body.Length}.");
            response.WithStatus(400, "Bad Request");
        }
    }

    // ---------------------------------------------------------------- SETUP

    private async Task HandleSetupAsync(AirPlayConnection conn, RtspRequest request, RtspResponse response)
    {
        var req = request.Body.Length > 0 ? BinaryPlist.ParseDict(request.Body) : new PlistDict();
        var result = new PlistDict();

        var ekey = req.GetData("ekey");
        var eiv = req.GetData("eiv");
        if (ekey != null && eiv != null)
        {
            if (!HandleSetupPhase1(conn, request, req, response, ekey, eiv))
            {
                return;
            }

            result["eventPort"] = 0L;
            result["timingPort"] = (long)(conn.Timing?.Port ?? 0);
        }

        var streams = req.GetArray("streams");
        if (streams != null)
        {
            if (!conn.HasSession || conn.SharedStreamKey == null)
            {
                _log.Warn("SETUP with streams before keys were established.");
                response.WithStatus(400, "Bad Request");
                return;
            }

            var resultStreams = new List<object?>();
            foreach (var item in streams)
            {
                if (item is not PlistDict stream)
                {
                    continue;
                }

                var type = stream.GetInt("type") ?? -1;
                switch (type)
                {
                    case 110:
                    {
                        var id = unchecked((ulong)(stream.GetInt("streamConnectionID") ?? 0));
                        conn.StopMirror();
                        var mirror = new MirrorStreamReceiver(_log, conn.SharedStreamKey, id, Options.MirrorDataPort);
                        _receiver.AttachMirrorEvents(conn, mirror);
                        mirror.Start();
                        conn.Mirror = mirror;
                        _log.Info($"Mirror stream set up (streamConnectionID {id}), data port {mirror.Port}");
                        resultStreams.Add(new PlistDict { ["type"] = 110L, ["dataPort"] = (long)mirror.Port });
                        break;
                    }

                    case 96:
                    {
                        var ct = (AudioCodec)(stream.GetInt("ct") ?? 8);
                        var spf = (int)(stream.GetInt("spf") ?? (ct == AudioCodec.Alac ? 352 : 480));
                        var remoteControlPort = (int)(stream.GetInt("controlPort") ?? 0);
                        var audioFormat = unchecked((ulong)(stream.GetInt("audioFormat") ?? 0));
                        var info = new AudioStreamInfo(ct, spf, 44100, 2, audioFormat);
                        conn.StopAudio();
                        var audio = new AudioStreamReceiver(_log, conn.SharedStreamKey, conn.AudioIv!, conn.Rtsp.RemoteAddress, remoteControlPort, info, Options.AudioDataPort, Options.AudioControlPort);
                        _receiver.AttachAudioEvents(conn, audio);
                        audio.Start();
                        conn.Audio = audio;
                        resultStreams.Add(new PlistDict { ["type"] = 96L, ["dataPort"] = (long)audio.DataPort, ["controlPort"] = (long)audio.ControlPort });
                        break;
                    }

                    default:
                        _log.Warn($"SETUP for unknown stream type {type}.");
                        break;
                }
            }

            result["streams"] = resultStreams;
        }

        response.WithBody(BinaryPlist.Write(result), BinaryPlistType);
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private bool HandleSetupPhase1(AirPlayConnection conn, RtspRequest request, PlistDict req, RtspResponse response, byte[] ekey, byte[] eiv)
    {
        var client = new ClientInfo
        {
            Name = req.GetString("name"),
            Model = req.GetString("model"),
            DeviceId = req.GetString("deviceID"),
            OsName = req.GetString("osName"),
            OsVersion = req.GetString("osVersion"),
            SourceVersion = req.GetString("sourceVersion"),
            Address = conn.Rtsp.RemoteAddress,
            UserAgent = request.Header("User-Agent"),
        };
        conn.Client = client;

        // Optional password, RFC 2617 Digest as iOS implements it.
        var password = Options.Password;
        if (!string.IsNullOrEmpty(password) && !conn.Authenticated)
        {
            var authorization = request.Header("Authorization");
            if (authorization != null && conn.Nonce != null)
            {
                conn.Authenticated = DigestAuth.Verify(request.Method, authorization, password, conn.Nonce);
                if (!conn.Authenticated)
                {
                    conn.AuthFailures++;
                    _log.Warn($"Password rejected for {client} (attempt {conn.AuthFailures}).");
                }
            }

            if (!conn.Authenticated)
            {
                conn.Nonce = DigestAuth.NewNonce();
                response.WithStatus(401, "Unauthorized");
                response.AddHeader("WWW-Authenticate", DigestAuth.Challenge(conn.Nonce));
                if (authorization == null)
                {
                    _log.Info($"Asking {client} for the AirPlay password.");
                }

                return false;
            }

            _log.Info($"Password accepted for {client}.");
        }

        if (!_receiver.TryClaimSession(conn))
        {
            _log.Warn($"Refusing {client}: another client is connected.");
            response.WithStatus(409, "Conflict: Server is connected to another client");
            return false;
        }

        if (ekey.Length != 72 || eiv.Length != 16)
        {
            _log.Error($"SETUP ekey/eiv have unexpected sizes ({ekey.Length}/{eiv.Length}).");
            response.WithStatus(400, "Bad Request");
            return false;
        }

        byte[] fpKey;
        try
        {
            fpKey = conn.FairPlay.DecryptKey(ekey);
        }
        catch (Exception ex)
        {
            _log.Error($"FairPlay key decryption failed: {ex.Message}");
            response.WithStatus(500, "Internal Server Error");
            return false;
        }

        var secret = conn.Pairing.EcdhSecret;
        if (secret == null)
        {
            _log.Warn("No pair-verify secret; using the unhashed FairPlay key (old-protocol client).");
        }

        conn.SharedStreamKey = AirPlayKeys.SharedStreamKey(fpKey, secret);
        conn.AudioIv = eiv;

        var timingProtocol = req.GetString("timingProtocol") ?? "NTP";
        var timingPort = (int)(req.GetInt("timingPort") ?? 0);
        conn.StopTiming();
        if (string.Equals(timingProtocol, "NTP", StringComparison.OrdinalIgnoreCase) && timingPort > 0)
        {
            var timing = new NtpTimingClient(_log, conn.Rtsp.RemoteAddress, timingPort, Options.TimingPort);
            timing.Start();
            conn.Timing = timing;
        }
        else
        {
            _log.Warn($"Client timingProtocol={timingProtocol}, timingPort={timingPort}: no clock sync (AirPlay 2 'remote control' mode is not supported).");
        }

        conn.HasSession = true;
        _log.Info($"Session established with {client}");
        _receiver.OnSessionStarted(conn);
        return true;
    }

    // ---------------------------------------------------------------- parameters

    private void HandleGetParameter(AirPlayConnection conn, RtspRequest request, RtspResponse response)
    {
        var text = Encoding.ASCII.GetString(request.Body);
        if (text.Contains("volume", StringComparison.OrdinalIgnoreCase))
        {
            var body = $"volume: {conn.VolumeDb.ToString("F6", CultureInfo.InvariantCulture)}\r\n";
            response.WithBody(Encoding.ASCII.GetBytes(body), "text/parameters");
        }
    }

    private void HandleSetParameter(AirPlayConnection conn, RtspRequest request, RtspResponse response)
    {
        var contentType = request.ContentType ?? "";
        if (contentType.StartsWith("text/parameters", StringComparison.OrdinalIgnoreCase))
        {
            var text = Encoding.ASCII.GetString(request.Body);
            foreach (var line in text.Split("\r\n", StringSplitOptions.RemoveEmptyEntries))
            {
                if (line.StartsWith("volume: ", StringComparison.OrdinalIgnoreCase)
                    && double.TryParse(line[8..].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var db))
                {
                    conn.VolumeDb = db;
                    _receiver.OnVolume(conn, db);
                }
                else if (line.StartsWith("progress: ", StringComparison.OrdinalIgnoreCase))
                {
                    _receiver.OnProgress(conn, line[10..].Trim());
                }
            }
        }
        else if (contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            _receiver.OnArtwork(conn, contentType, request.Body);
        }
        else if (contentType.StartsWith("application/x-dmap-tagged", StringComparison.OrdinalIgnoreCase))
        {
            _receiver.OnMetadata(conn, request.Body);
        }
    }

    private void HandleTeardown(AirPlayConnection conn, RtspRequest request, RtspResponse response)
    {
        var teardown96 = false;
        var teardown110 = false;
        if (request.Body.Length > 0)
        {
            var streams = BinaryPlist.ParseDict(request.Body).GetArray("streams");
            if (streams != null)
            {
                foreach (var item in streams)
                {
                    if (item is PlistDict d)
                    {
                        var t = d.GetInt("type");
                        teardown96 |= t == 96;
                        teardown110 |= t == 110;
                    }
                }
            }
        }

        response.AddHeader("Connection", "close");
        if (teardown96 || teardown110)
        {
            if (teardown96)
            {
                _log.Info("TEARDOWN audio stream");
                conn.StopAudio();
            }

            if (teardown110)
            {
                _log.Info("TEARDOWN mirror stream");
                conn.StopMirror();
                _receiver.OnMirrorStopped(conn);
            }
        }
        else
        {
            _log.Info("TEARDOWN session");
            _receiver.EndSession(conn, "client ended the session");
        }
    }
}
