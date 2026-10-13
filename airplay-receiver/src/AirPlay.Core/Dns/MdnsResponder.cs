using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace AirPlay.Dns;

/// <summary>
/// A small multicast-DNS responder (RFC 6762 / 6763) that advertises the receiver's
/// services on every usable IPv4 interface. It answers only for its own names, so it
/// coexists with Bonjour, Avahi and the Windows built-in resolver on port 5353.
/// Probing / name-conflict resolution is intentionally not implemented.
/// </summary>
public sealed class MdnsResponder : IDisposable
{
    public const int Port = 5353;
    public const uint ServiceTtl = 4500;
    public const uint HostTtl = 120;

    private static readonly IPAddress Group4 = IPAddress.Parse("224.0.0.251");
    private static readonly IPAddress Group6 = IPAddress.Parse("ff02::fb");
    private static readonly IPEndPoint GroupEndpoint4 = new(Group4, Port);
    private static readonly IPEndPoint GroupEndpoint6 = new(Group6, Port);
    private static readonly DnsName ServicesEnumName = DnsName.Parse("_services._dns-sd._udp.local");

    private readonly Log _log;
    private readonly object _lock = new();
    private readonly List<(int Index, IPAddress Address, IPAddress? Mask)> _interfaces = new();
    private Socket? _socket4;
    private Socket? _socket6;
    private CancellationTokenSource? _cts;
    private IReadOnlyList<MdnsService> _services;

    public MdnsResponder(Log log, string hostName, IReadOnlyList<MdnsService> services)
    {
        _log = log;
        HostName = DnsName.Parse(hostName);
        _services = services;
    }

    public DnsName HostName { get; }

    public IReadOnlyList<MdnsService> Services
    {
        get => _services;
        set
        {
            _services = value;
        }
    }

    public void Start()
    {
        _cts = new CancellationTokenSource();
        RefreshInterfaces();
        _socket4 = OpenIPv4();
        _socket6 = OpenIPv6();
        if (_socket4 == null && _socket6 == null)
        {
            throw new InvalidOperationException("Could not open an mDNS socket on port 5353.");
        }

        if (_socket4 != null)
        {
            _ = ReceiveLoopAsync(_socket4, AddressFamily.InterNetwork, _cts.Token);
        }

        if (_socket6 != null)
        {
            _ = ReceiveLoopAsync(_socket6, AddressFamily.InterNetworkV6, _cts.Token);
        }

        _ = AnnounceAsync(_cts.Token);
        NetworkChange.NetworkAddressChanged += OnNetworkAddressChanged;
    }

    public void Stop()
    {
        NetworkChange.NetworkAddressChanged -= OnNetworkAddressChanged;
        try
        {
            Goodbye();
        }
        catch (Exception ex)
        {
            _log.Debug($"mDNS goodbye failed: {ex.Message}");
        }

        _cts?.Cancel();
        _socket4?.Dispose();
        _socket6?.Dispose();
        _socket4 = null;
        _socket6 = null;
    }

    public void Dispose() => Stop();

    /// <summary>Re-sends the unsolicited announcement (e.g. after the TXT record changed).</summary>
    public void Announce()
    {
        if (_cts != null)
        {
            _ = AnnounceAsync(_cts.Token);
        }
    }

    private void OnNetworkAddressChanged(object? sender, EventArgs e)
    {
        try
        {
            RefreshInterfaces();
            JoinGroups();
            Announce();
        }
        catch (Exception ex)
        {
            _log.Debug($"mDNS interface refresh failed: {ex.Message}");
        }
    }

    // ---------------------------------------------------------------- sockets

    private void RefreshInterfaces()
    {
        var list = new List<(int, IPAddress, IPAddress?)>();
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback)
            {
                continue;
            }

            if (!nic.Supports(NetworkInterfaceComponent.IPv4))
            {
                continue;
            }

            IPInterfaceProperties props;
            int index;
            try
            {
                props = nic.GetIPProperties();
                index = props.GetIPv4Properties()?.Index ?? -1;
            }
            catch
            {
                continue;
            }

            foreach (var ua in props.UnicastAddresses)
            {
                if (ua.Address.AddressFamily != AddressFamily.InterNetwork)
                {
                    continue;
                }

                var bytes = ua.Address.GetAddressBytes();
                if (bytes[0] == 169 && bytes[1] == 254)
                {
                    continue; // APIPA
                }

                list.Add((index, ua.Address, ua.IPv4Mask));
            }
        }

        lock (_lock)
        {
            _interfaces.Clear();
            _interfaces.AddRange(list);
        }

        _log.Debug($"mDNS interfaces: {string.Join(", ", list.Select(i => $"{i.Item2} (#{i.Item1})"))}");
    }

    private Socket? OpenIPv4()
    {
        try
        {
            var s = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            s.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            s.ExclusiveAddressUse = false;
            s.Bind(new IPEndPoint(IPAddress.Any, Port));
            s.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastTimeToLive, 255);
            s.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastLoopback, true);
            s.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.PacketInformation, true);
            _socket4 = s;
            JoinGroups();
            return s;
        }
        catch (Exception ex)
        {
            _log.Warn($"mDNS IPv4 socket failed: {ex.Message}");
            return null;
        }
    }

    private Socket? OpenIPv6()
    {
        try
        {
            var s = new Socket(AddressFamily.InterNetworkV6, SocketType.Dgram, ProtocolType.Udp);
            s.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            s.ExclusiveAddressUse = false;
            s.Bind(new IPEndPoint(IPAddress.IPv6Any, Port));
            s.SetSocketOption(SocketOptionLevel.IPv6, SocketOptionName.MulticastTimeToLive, 255);
            s.SetSocketOption(SocketOptionLevel.IPv6, SocketOptionName.PacketInformation, true);
            var joined = 0;
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback || !nic.Supports(NetworkInterfaceComponent.IPv6))
                {
                    continue;
                }

                try
                {
                    var idx = nic.GetIPProperties().GetIPv6Properties()?.Index ?? -1;
                    if (idx < 0)
                    {
                        continue;
                    }

                    s.SetSocketOption(SocketOptionLevel.IPv6, SocketOptionName.AddMembership, new IPv6MulticastOption(Group6, idx));
                    joined++;
                }
                catch
                {
                    // interface without IPv6 multicast
                }
            }

            if (joined == 0)
            {
                s.Dispose();
                return null;
            }

            return s;
        }
        catch (Exception ex)
        {
            _log.Debug($"mDNS IPv6 socket not available: {ex.Message}");
            return null;
        }
    }

    private void JoinGroups()
    {
        var s = _socket4;
        if (s == null)
        {
            return;
        }

        (int, IPAddress, IPAddress?)[] ifs;
        lock (_lock)
        {
            ifs = _interfaces.ToArray();
        }

        foreach (var (_, address, _) in ifs)
        {
            try
            {
                s.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.AddMembership, new MulticastOption(Group4, address));
            }
            catch (SocketException ex) when (ex.SocketErrorCode == SocketError.AddressAlreadyInUse)
            {
                // already joined
            }
            catch (Exception ex)
            {
                _log.Debug($"mDNS join on {address} failed: {ex.Message}");
            }
        }
    }

    // ---------------------------------------------------------------- receive

    private async Task ReceiveLoopAsync(Socket socket, AddressFamily family, CancellationToken ct)
    {
        var buffer = new byte[9000];
        var anyEp = new IPEndPoint(family == AddressFamily.InterNetwork ? IPAddress.Any : IPAddress.IPv6Any, 0);
        while (!ct.IsCancellationRequested)
        {
            SocketReceiveMessageFromResult result;
            try
            {
                result = await socket.ReceiveMessageFromAsync(buffer, SocketFlags.None, anyEp, ct).ConfigureAwait(false);
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

                _log.Debug($"mDNS receive error: {ex.SocketErrorCode}");
                await Task.Delay(50, ct).ConfigureAwait(false);
                continue;
            }

            try
            {
                HandlePacket(socket, family, buffer.AsSpan(0, result.ReceivedBytes), (IPEndPoint)result.RemoteEndPoint, result.PacketInformation.Interface);
            }
            catch (Exception ex)
            {
                _log.Debug($"mDNS packet handling failed: {ex.Message}");
            }
        }
    }

    private void HandlePacket(Socket socket, AddressFamily family, ReadOnlySpan<byte> packet, IPEndPoint from, int ifIndex)
    {
        var msg = DnsReader.TryParse(packet);
        if (msg == null || msg.IsResponse || msg.Questions.Count == 0)
        {
            return;
        }

        var services = _services;
        var wantServices = new HashSet<MdnsService>();
        var wantEnumeration = false;
        var wantHost = false;
        var unicast = false;
        foreach (var q in msg.Questions)
        {
            if (q.Class != DnsWriter.ClassIn && q.Class != 255)
            {
                continue;
            }

            unicast |= q.UnicastResponse;
            if (q.Name.Equals(ServicesEnumName) && Matches(q.Type, DnsType.PTR))
            {
                wantEnumeration = true;
                continue;
            }

            foreach (var svc in services)
            {
                if (q.Name.Equals(svc.Type) && Matches(q.Type, DnsType.PTR))
                {
                    if (!KnownAnswerSuppresses(msg, svc))
                    {
                        wantServices.Add(svc);
                    }
                }
                else if (q.Name.Equals(svc.Name) && (Matches(q.Type, DnsType.SRV) || Matches(q.Type, DnsType.TXT)))
                {
                    wantServices.Add(svc);
                }
            }

            if (q.Name.Equals(HostName) && (Matches(q.Type, DnsType.A) || Matches(q.Type, DnsType.AAAA)))
            {
                wantHost = true;
            }
        }

        if (!wantEnumeration && wantServices.Count == 0 && !wantHost)
        {
            return;
        }

        var legacy = from.Port != Port;
        var address = PickAddress(ifIndex, from.Address);
        if (address == null)
        {
            _log.Debug("mDNS: no IPv4 address to answer with.");
            return;
        }

        var response = BuildResponse(legacy ? msg.Id : (ushort)0, services, wantEnumeration ? services : Array.Empty<MdnsService>(), wantServices, wantHost, address, legacy ? Math.Min(ServiceTtl, 10u) : ServiceTtl, cacheFlush: !legacy);
        if (legacy || unicast)
        {
            SendTo(socket, response, from, ifIndex, address);
        }

        if (!legacy)
        {
            SendMulticast(socket, family, response, ifIndex, address);
        }
    }

    private static bool Matches(ushort queryType, ushort recordType) => queryType == recordType || queryType == DnsType.ANY;

    private static bool KnownAnswerSuppresses(DnsMessageView msg, MdnsService svc)
    {
        foreach (var a in msg.Answers)
        {
            if (a.Type == DnsType.PTR && a.Name.Equals(svc.Type) && a.PtrTarget != null && a.PtrTarget.Equals(svc.Name) && a.Ttl > ServiceTtl / 2)
            {
                return true;
            }
        }

        return false;
    }

    private IPAddress? PickAddress(int ifIndex, IPAddress from)
    {
        (int, IPAddress, IPAddress?)[] ifs;
        lock (_lock)
        {
            ifs = _interfaces.ToArray();
        }

        if (ifs.Length == 0)
        {
            return null;
        }

        foreach (var (index, address, _) in ifs)
        {
            if (index == ifIndex)
            {
                return address;
            }
        }

        if (from.AddressFamily == AddressFamily.InterNetwork)
        {
            var fb = from.GetAddressBytes();
            foreach (var (_, address, mask) in ifs)
            {
                if (mask == null)
                {
                    continue;
                }

                var ab = address.GetAddressBytes();
                var mb = mask.GetAddressBytes();
                var same = true;
                for (var i = 0; i < 4; i++)
                {
                    if ((ab[i] & mb[i]) != (fb[i] & mb[i]))
                    {
                        same = false;
                        break;
                    }
                }

                if (same)
                {
                    return address;
                }
            }
        }

        return ifs[0].Item2;
    }

    // ---------------------------------------------------------------- build / send

    private byte[] BuildResponse(ushort id, IReadOnlyList<MdnsService> all, IReadOnlyList<MdnsService> enumerate, IEnumerable<MdnsService> services, bool host, IPAddress address, uint ttl, bool cacheFlush)
    {
        var w = new DnsWriter(id);
        foreach (var svc in enumerate)
        {
            w.AddPtr(ServicesEnumName, svc.Type, ttl);
        }

        var wroteHost = false;
        foreach (var svc in services)
        {
            w.AddPtr(svc.Type, svc.Name, ttl);
            w.AddSrv(svc.Name, 0, 0, svc.Port, HostName, ttl, cacheFlush);
            w.AddTxt(svc.Name, svc.TxtEntries, ttl, cacheFlush);
            if (!wroteHost)
            {
                w.AddAddress(HostName, address, host ? ttl : Math.Min(ttl, HostTtl), cacheFlush);
                wroteHost = true;
            }
        }

        if (host && !wroteHost)
        {
            w.AddAddress(HostName, address, Math.Min(ttl, HostTtl), cacheFlush);
        }

        return w.ToArray();
    }

    private byte[] BuildAnnouncement(IReadOnlyList<MdnsService> services, IPAddress address, uint ttl)
    {
        var w = new DnsWriter(0);
        foreach (var svc in services)
        {
            w.AddPtr(ServicesEnumName, svc.Type, ttl);
            w.AddPtr(svc.Type, svc.Name, ttl);
            w.AddSrv(svc.Name, 0, 0, svc.Port, HostName, ttl, cacheFlush: true);
            w.AddTxt(svc.Name, svc.TxtEntries, ttl, cacheFlush: true);
        }

        w.AddAddress(HostName, address, ttl == 0 ? 0 : HostTtl, cacheFlush: true);
        return w.ToArray();
    }

    private async Task AnnounceAsync(CancellationToken ct)
    {
        try
        {
            for (var i = 0; i < 3 && !ct.IsCancellationRequested; i++)
            {
                SendToAllInterfaces(ServiceTtl);
                await Task.Delay(1000, ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            _log.Debug($"mDNS announce failed: {ex.Message}");
        }
    }

    private void Goodbye() => SendToAllInterfaces(0);

    private void SendToAllInterfaces(uint ttl)
    {
        var services = _services;
        (int, IPAddress, IPAddress?)[] ifs;
        lock (_lock)
        {
            ifs = _interfaces.ToArray();
        }

        var s4 = _socket4;
        if (s4 != null)
        {
            foreach (var (index, address, _) in ifs)
            {
                var packet = BuildAnnouncement(services, address, ttl);
                SendMulticast(s4, AddressFamily.InterNetwork, packet, index, address);
            }
        }

        var s6 = _socket6;
        if (s6 != null && ifs.Length > 0)
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                try
                {
                    if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                    {
                        continue;
                    }

                    var props = nic.GetIPProperties();
                    var idx6 = props.GetIPv6Properties()?.Index ?? -1;
                    var idx4 = props.GetIPv4Properties()?.Index ?? -1;
                    var v4 = ifs.FirstOrDefault(i => i.Item1 == idx4).Item2;
                    if (idx6 < 0 || v4 == null)
                    {
                        continue;
                    }

                    SendMulticast(s6, AddressFamily.InterNetworkV6, BuildAnnouncement(services, v4, ttl), idx6, v4);
                }
                catch
                {
                    // ignore interfaces that refuse
                }
            }
        }
    }

    private void SendMulticast(Socket socket, AddressFamily family, byte[] packet, int ifIndex, IPAddress ifAddress)
    {
        try
        {
            if (family == AddressFamily.InterNetwork)
            {
                socket.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastInterface, ifAddress.GetAddressBytes());
                socket.SendTo(packet, GroupEndpoint4);
            }
            else
            {
                if (ifIndex > 0)
                {
                    socket.SetSocketOption(SocketOptionLevel.IPv6, SocketOptionName.MulticastInterface, ifIndex);
                }

                socket.SendTo(packet, GroupEndpoint6);
            }
        }
        catch (Exception ex)
        {
            _log.Debug($"mDNS multicast send failed on {ifAddress}: {ex.Message}");
        }
    }

    private void SendTo(Socket socket, byte[] packet, IPEndPoint to, int ifIndex, IPAddress ifAddress)
    {
        try
        {
            socket.SendTo(packet, to);
        }
        catch (Exception ex)
        {
            _log.Debug($"mDNS unicast send to {to} failed: {ex.Message}");
        }
    }
}
