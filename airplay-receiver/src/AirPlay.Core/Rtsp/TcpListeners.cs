using System.Net;
using System.Net.Sockets;

namespace AirPlay.Rtsp;

/// <summary>Creates listeners that accept both IPv6 and IPv4 clients, falling back to IPv4 only where IPv6 is unavailable.</summary>
public static class TcpListeners
{
    public static TcpListener Create(int port, int backlog, Log log, string purpose)
    {
        var preferred = port;
        try
        {
            return StartDualStack(port, backlog);
        }
        catch (SocketException ex) when (ex.SocketErrorCode is SocketError.AddressFamilyNotSupported or SocketError.ProtocolNotSupported || !Socket.OSSupportsIPv6)
        {
            log.Debug($"IPv6 unavailable for {purpose}; listening on IPv4 only.");
        }
        catch (SocketException ex) when (port != 0)
        {
            log.Warn($"TCP port {port} for {purpose} unavailable ({ex.SocketErrorCode}); using an ephemeral port.");
            port = 0;
            try
            {
                return StartDualStack(0, backlog);
            }
            catch (SocketException)
            {
                // fall through to IPv4
            }
        }

        try
        {
            return StartIPv4(port, backlog);
        }
        catch (SocketException ex) when (port != 0)
        {
            log.Warn($"TCP port {preferred} for {purpose} unavailable ({ex.SocketErrorCode}); using an ephemeral port.");
            return StartIPv4(0, backlog);
        }
    }

    private static TcpListener StartDualStack(int port, int backlog)
    {
        var listener = new TcpListener(IPAddress.IPv6Any, port);
        listener.Server.DualMode = true;
        listener.Start(backlog);
        return listener;
    }

    private static TcpListener StartIPv4(int port, int backlog)
    {
        var listener = new TcpListener(IPAddress.Any, port);
        listener.Start(backlog);
        return listener;
    }
}
