using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace AirPlay.Streams;

/// <summary>
/// The receiver-side NTP-style clock sync: we periodically send timing requests to the
/// client's timing port and estimate the offset between the client clock and ours.
/// The offset lets the UI estimate glass-to-glass latency and lets audio/video be aligned.
/// </summary>
public sealed class NtpTimingClient : IDisposable
{
    private readonly Log _log;
    private readonly IPEndPoint _remote;
    private readonly int _preferredPort;
    private Socket? _socket;
    private Thread? _thread;
    private volatile bool _running;
    private readonly object _lock = new();
    private readonly List<(double Offset, double Delay)> _samples = new();
    private ulong _lastT3;

    public NtpTimingClient(Log log, IPAddress clientAddress, int clientTimingPort, int preferredLocalPort)
    {
        _log = log;
        _remote = new IPEndPoint(clientAddress, clientTimingPort);
        _preferredPort = preferredLocalPort;
    }

    public int Port { get; private set; }

    /// <summary>Estimated (client clock - local clock) in seconds, or null until the first reply.</summary>
    public double? OffsetSeconds
    {
        get
        {
            lock (_lock)
            {
                if (_samples.Count == 0)
                {
                    return null;
                }

                // Use the sample with the smallest round-trip: it has the least queuing noise.
                return _samples.MinBy(s => s.Delay).Offset;
            }
        }
    }

    public double? RoundTripSeconds
    {
        get
        {
            lock (_lock)
            {
                return _samples.Count == 0 ? null : _samples.Min(s => s.Delay);
            }
        }
    }

    /// <summary>Converts a client NTP timestamp to our local NTP clock, if the offset is known.</summary>
    public ulong? RemoteToLocal(ulong remoteNtp)
    {
        var offset = OffsetSeconds;
        return offset == null ? null : Ntp.AddSeconds(remoteNtp, -offset.Value);
    }

    public void Start()
    {
        _socket = UdpPorts.Bind(_remote.AddressFamily, _preferredPort, _log, "timing");
        Port = ((IPEndPoint)_socket.LocalEndPoint!).Port;
        _socket.ReceiveTimeout = 300;
        _running = true;
        _thread = new Thread(Loop) { IsBackground = true, Name = "airplay-ntp" };
        _thread.Start();
    }

    public void Stop()
    {
        _running = false;
        _socket?.Dispose();
        _socket = null;
    }

    public void Dispose() => Stop();

    private void Loop()
    {
        var request = new byte[32];
        var response = new byte[128];
        var sent = 0;
        var remoteEp = new IPEndPoint(_remote.Address, _remote.Port);
        EndPoint anyEp = new IPEndPoint(_remote.AddressFamily == AddressFamily.InterNetwork ? IPAddress.Any : IPAddress.IPv6Any, 0);
        while (_running)
        {
            var socket = _socket;
            if (socket == null)
            {
                return;
            }

            try
            {
                request[0] = 0x80;
                request[1] = 0xd2;
                request[2] = 0x00;
                request[3] = 0x07;
                BinaryPrimitives.WriteUInt64BigEndian(request.AsSpan(8), _lastT3);
                var t1 = Ntp.LocalNow();
                BinaryPrimitives.WriteUInt64BigEndian(request.AsSpan(24), t1);
                socket.SendTo(request, remoteEp);
                sent++;

                int n;
                try
                {
                    n = socket.ReceiveFrom(response, ref anyEp);
                }
                catch (SocketException ex) when (ex.SocketErrorCode is SocketError.TimedOut or SocketError.WouldBlock)
                {
                    n = 0;
                }

                var t4 = Ntp.LocalNow();
                if (n >= 32)
                {
                    var echoedT1 = BinaryPrimitives.ReadUInt64BigEndian(response.AsSpan(8));
                    var t2 = BinaryPrimitives.ReadUInt64BigEndian(response.AsSpan(16));
                    var t3 = BinaryPrimitives.ReadUInt64BigEndian(response.AsSpan(24));
                    _lastT3 = t3;
                    if (echoedT1 == t1)
                    {
                        var s1 = Ntp.ToSeconds(t1);
                        var s2 = Ntp.ToSeconds(t2);
                        var s3 = Ntp.ToSeconds(t3);
                        var s4 = Ntp.ToSeconds(t4);
                        var offset = ((s2 - s1) + (s3 - s4)) / 2.0;
                        var delay = (s4 - s1) - (s3 - s2);
                        lock (_lock)
                        {
                            _samples.Add((offset, Math.Max(0, delay)));
                            if (_samples.Count > 8)
                            {
                                _samples.RemoveAt(0);
                            }
                        }

                        _log.Debug($"ntp: offset {offset * 1000:F2} ms, rtt {delay * 1000:F2} ms");
                    }
                }
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (SocketException ex)
            {
                if (!_running)
                {
                    return;
                }

                _log.Debug($"ntp: socket error {ex.SocketErrorCode}");
            }
            catch (Exception ex)
            {
                _log.Debug($"ntp: {ex.Message}");
            }

            // A quick burst at the start, then one request every three seconds.
            Thread.Sleep(sent < 6 ? 200 : 3000);
        }
    }
}

internal static class UdpPorts
{
    public static Socket Bind(AddressFamily family, int preferredPort, Log log, string purpose)
    {
        var socket = new Socket(family, SocketType.Dgram, ProtocolType.Udp);
        var any = family == AddressFamily.InterNetwork ? IPAddress.Any : IPAddress.IPv6Any;
        try
        {
            socket.Bind(new IPEndPoint(any, preferredPort));
        }
        catch (SocketException ex) when (preferredPort != 0)
        {
            log.Warn($"UDP port {preferredPort} for {purpose} unavailable ({ex.SocketErrorCode}); using an ephemeral port.");
            socket.Bind(new IPEndPoint(any, 0));
        }

        return socket;
    }
}
