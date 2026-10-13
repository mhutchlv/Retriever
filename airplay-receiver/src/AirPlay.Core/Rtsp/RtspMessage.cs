using System.Text;

namespace AirPlay.Rtsp;

/// <summary>An RTSP/1.0 or HTTP/1.1 request as sent by the AirPlay client.</summary>
public sealed class RtspRequest
{
    public RtspRequest(string method, string uri, string protocol, Dictionary<string, string> headers, byte[] body)
    {
        Method = method;
        Uri = uri;
        Protocol = protocol;
        Headers = headers;
        Body = body;
    }

    public string Method { get; }
    public string Uri { get; }
    public string Protocol { get; }
    public Dictionary<string, string> Headers { get; }
    public byte[] Body { get; }

    public string? Header(string name) => Headers.TryGetValue(name, out var v) ? v : null;

    public string? CSeq => Header("CSeq");

    public string? ContentType => Header("Content-Type");

    /// <summary>The path part of the URI ("/fp-setup" for "/fp-setup", "/12345" for "rtsp://host/12345").</summary>
    public string Path
    {
        get
        {
            var uri = Uri;
            var scheme = uri.IndexOf("://", StringComparison.Ordinal);
            if (scheme >= 0)
            {
                var slash = uri.IndexOf('/', scheme + 3);
                uri = slash >= 0 ? uri[slash..] : "/";
            }

            var q = uri.IndexOf('?');
            return q >= 0 ? uri[..q] : uri;
        }
    }

    public override string ToString() => $"{Method} {Uri} {Protocol} ({Body.Length} bytes)";
}

public sealed class RtspResponse
{
    public RtspResponse(string protocol, int status = 200, string reason = "OK")
    {
        Protocol = protocol;
        Status = status;
        Reason = reason;
    }

    public string Protocol { get; }
    public int Status { get; set; }
    public string Reason { get; set; }
    public List<KeyValuePair<string, string>> Headers { get; } = new();
    public byte[]? Body { get; set; }
    public string? ContentType { get; set; }

    /// <summary>When true, the connection is closed after the response is sent.</summary>
    public bool CloseConnection { get; set; }

    public RtspResponse WithStatus(int status, string reason)
    {
        Status = status;
        Reason = reason;
        return this;
    }

    public RtspResponse AddHeader(string name, string value)
    {
        Headers.Add(new KeyValuePair<string, string>(name, value));
        return this;
    }

    public RtspResponse WithBody(byte[] body, string contentType)
    {
        Body = body;
        ContentType = contentType;
        return this;
    }

    public byte[] Serialize()
    {
        var sb = new StringBuilder();
        sb.Append(Protocol).Append(' ').Append(Status).Append(' ').Append(Reason).Append("\r\n");
        foreach (var kv in Headers)
        {
            sb.Append(kv.Key).Append(": ").Append(kv.Value).Append("\r\n");
        }

        if (ContentType != null)
        {
            sb.Append("Content-Type: ").Append(ContentType).Append("\r\n");
        }

        var bodyLen = Body?.Length ?? 0;
        if (bodyLen > 0 || ContentType != null)
        {
            sb.Append("Content-Length: ").Append(bodyLen).Append("\r\n");
        }

        sb.Append("\r\n");
        var head = Encoding.ASCII.GetBytes(sb.ToString());
        if (bodyLen == 0)
        {
            return head;
        }

        var all = new byte[head.Length + bodyLen];
        head.CopyTo(all, 0);
        Body!.CopyTo(all, head.Length);
        return all;
    }
}

/// <summary>Incremental parser for the request framing shared by RTSP/1.0 and HTTP/1.1.</summary>
public static class RtspParser
{
    public const int MaxHeaderBytes = 16 * 1024;
    public const int MaxBodyBytes = 4 * 1024 * 1024;

    /// <summary>
    /// Tries to parse one complete request from the start of <paramref name="buffer"/>.
    /// Returns false if more bytes are needed. Throws <see cref="FormatException"/> on malformed input.
    /// </summary>
    public static bool TryParse(ReadOnlySpan<byte> buffer, out RtspRequest? request, out int consumed)
    {
        request = null;
        consumed = 0;
        var headerEnd = IndexOfHeaderEnd(buffer);
        if (headerEnd < 0)
        {
            if (buffer.Length > MaxHeaderBytes)
            {
                throw new FormatException("Request header too large.");
            }

            return false;
        }

        var headerText = Encoding.UTF8.GetString(buffer[..headerEnd]);
        var lines = headerText.Split("\r\n");
        var requestLine = lines[0].Split(' ', 3, StringSplitOptions.RemoveEmptyEntries);
        if (requestLine.Length != 3)
        {
            throw new FormatException($"Malformed request line: '{lines[0]}'.");
        }

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 1; i < lines.Length; i++)
        {
            var line = lines[i];
            if (line.Length == 0)
            {
                continue;
            }

            var colon = line.IndexOf(':');
            if (colon <= 0)
            {
                throw new FormatException($"Malformed header line: '{line}'.");
            }

            var name = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim();
            headers[name] = headers.TryGetValue(name, out var existing) ? existing + ", " + value : value;
        }

        var bodyLength = 0;
        if (headers.TryGetValue("Content-Length", out var cl))
        {
            if (!int.TryParse(cl, out bodyLength) || bodyLength < 0 || bodyLength > MaxBodyBytes)
            {
                throw new FormatException($"Bad Content-Length '{cl}'.");
            }
        }

        var bodyStart = headerEnd + 4;
        if (buffer.Length < bodyStart + bodyLength)
        {
            return false;
        }

        var body = bodyLength == 0 ? Array.Empty<byte>() : buffer.Slice(bodyStart, bodyLength).ToArray();
        request = new RtspRequest(requestLine[0], requestLine[1], requestLine[2], headers, body);
        consumed = bodyStart + bodyLength;
        return true;
    }

    private static int IndexOfHeaderEnd(ReadOnlySpan<byte> buffer)
    {
        ReadOnlySpan<byte> marker = "\r\n\r\n"u8;
        return buffer.IndexOf(marker);
    }
}
