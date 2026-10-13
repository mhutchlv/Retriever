using System.Net;
using System.Net.Sockets;

namespace AirPlay.Rtsp;

public delegate Task<RtspResponse?> RtspRequestHandler(RtspConnection connection, RtspRequest request);

/// <summary>A connection from one AirPlay client. The client keeps it open for the whole session.</summary>
public sealed class RtspConnection
{
    private readonly TcpClient _client;
    private readonly NetworkStream _stream;
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    internal RtspConnection(TcpClient client)
    {
        _client = client;
        _stream = client.GetStream();
        RemoteEndPoint = (IPEndPoint)client.Client.RemoteEndPoint!;
        LocalEndPoint = (IPEndPoint)client.Client.LocalEndPoint!;
        Id = Interlocked.Increment(ref _nextId);
    }

    private static int _nextId;

    public int Id { get; }
    public IPEndPoint RemoteEndPoint { get; }
    public IPEndPoint LocalEndPoint { get; }

    /// <summary>Remote address with any IPv4-mapped-IPv6 prefix removed.</summary>
    public IPAddress RemoteAddress => RemoteEndPoint.Address.IsIPv4MappedToIPv6 ? RemoteEndPoint.Address.MapToIPv4() : RemoteEndPoint.Address;

    public IPAddress LocalAddress => LocalEndPoint.Address.IsIPv4MappedToIPv6 ? LocalEndPoint.Address.MapToIPv4() : LocalEndPoint.Address;

    /// <summary>Free slot for the protocol layer to hang its per-connection state on.</summary>
    public object? State { get; set; }

    public DateTime LastActivityUtc { get; internal set; } = DateTime.UtcNow;

    public bool IsConnected => _client.Connected;

    public async Task SendAsync(RtspResponse response, CancellationToken ct)
    {
        var bytes = response.Serialize();
        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await _stream.WriteAsync(bytes, ct).ConfigureAwait(false);
            await _stream.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public void Close()
    {
        try
        {
            _client.Close();
        }
        catch
        {
            // ignore
        }
    }

    internal NetworkStream Stream => _stream;
}

/// <summary>TCP server speaking the RTSP/HTTP hybrid that AirPlay clients use on port 7000.</summary>
public sealed class RtspServer : IDisposable
{
    private readonly Log _log;
    private readonly RtspRequestHandler _handler;
    private TcpListener? _listener;
    private CancellationTokenSource? _cts;
    private readonly List<RtspConnection> _connections = new();

    public RtspServer(Log log, RtspRequestHandler handler)
    {
        _log = log;
        _handler = handler;
    }

    public int Port { get; private set; }

    public event Action<RtspConnection>? ConnectionOpened;
    public event Action<RtspConnection>? ConnectionClosed;

    public IReadOnlyList<RtspConnection> Connections
    {
        get
        {
            lock (_connections)
            {
                return _connections.ToArray();
            }
        }
    }

    public void Start(int port)
    {
        _cts = new CancellationTokenSource();
        _listener = TcpListeners.Create(port, 8, _log, "RTSP");
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _log.Info($"RTSP server listening on port {Port}");
        _ = AcceptLoopAsync(_listener, _cts.Token);
    }

    public void Stop()
    {
        _cts?.Cancel();
        _listener?.Stop();
        RtspConnection[] open;
        lock (_connections)
        {
            open = _connections.ToArray();
            _connections.Clear();
        }

        foreach (var c in open)
        {
            c.Close();
        }
    }

    public void Dispose() => Stop();

    private async Task AcceptLoopAsync(TcpListener listener, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (SocketException ex)
            {
                if (ct.IsCancellationRequested)
                {
                    return;
                }

                _log.Warn($"Accept failed: {ex.Message}");
                await Task.Delay(100, ct).ConfigureAwait(false);
                continue;
            }

            client.NoDelay = true;
            var conn = new RtspConnection(client);
            lock (_connections)
            {
                _connections.Add(conn);
            }

            _ = Task.Run(() => ServeAsync(conn, ct), ct);
        }
    }

    private async Task ServeAsync(RtspConnection conn, CancellationToken ct)
    {
        _log.Debug($"Connection #{conn.Id} from {conn.RemoteAddress}");
        try
        {
            ConnectionOpened?.Invoke(conn);
        }
        catch (Exception ex)
        {
            _log.Error($"ConnectionOpened handler failed: {ex}");
        }

        var buffer = new byte[64 * 1024];
        var filled = 0;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                // Try to parse everything already buffered.
                while (true)
                {
                    RtspRequest? request;
                    int consumed;
                    try
                    {
                        if (!RtspParser.TryParse(buffer.AsSpan(0, filled), out request, out consumed))
                        {
                            break;
                        }
                    }
                    catch (FormatException ex)
                    {
                        _log.Warn($"Connection #{conn.Id}: malformed request ({ex.Message}); closing.");
                        return;
                    }

                    Buffer.BlockCopy(buffer, consumed, buffer, 0, filled - consumed);
                    filled -= consumed;
                    conn.LastActivityUtc = DateTime.UtcNow;

                    RtspResponse? response;
                    try
                    {
                        response = await _handler(conn, request!).ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        _log.Error($"Connection #{conn.Id}: handler for {request} threw: {ex}");
                        response = new RtspResponse(request!.Protocol, 500, "Internal Server Error");
                        if (request.CSeq != null)
                        {
                            response.AddHeader("CSeq", request.CSeq);
                        }
                    }

                    if (response != null)
                    {
                        await conn.SendAsync(response, ct).ConfigureAwait(false);
                        if (response.CloseConnection)
                        {
                            return;
                        }
                    }
                }

                if (filled == buffer.Length)
                {
                    if (buffer.Length >= RtspParser.MaxBodyBytes + RtspParser.MaxHeaderBytes)
                    {
                        _log.Warn($"Connection #{conn.Id}: request too large; closing.");
                        return;
                    }

                    Array.Resize(ref buffer, buffer.Length * 2);
                }

                int read;
                try
                {
                    read = await conn.Stream.ReadAsync(buffer.AsMemory(filled), ct).ConfigureAwait(false);
                }
                catch (IOException)
                {
                    return;
                }
                catch (ObjectDisposedException)
                {
                    return;
                }

                if (read <= 0)
                {
                    return;
                }

                filled += read;
            }
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }
        catch (Exception ex)
        {
            _log.Error($"Connection #{conn.Id} failed: {ex}");
        }
        finally
        {
            lock (_connections)
            {
                _connections.Remove(conn);
            }

            conn.Close();
            _log.Debug($"Connection #{conn.Id} closed");
            try
            {
                ConnectionClosed?.Invoke(conn);
            }
            catch (Exception ex)
            {
                _log.Error($"ConnectionClosed handler failed: {ex}");
            }
        }
    }
}
