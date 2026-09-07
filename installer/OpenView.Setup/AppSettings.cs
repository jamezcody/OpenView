using System.Globalization;
using System.Text.Json;

namespace OpenView.Setup;

internal sealed record AppSettings(string PhotonApiUrl, int Port)
{
    internal const int DefaultPort = 8787;
    internal static AppSettings Default => new(string.Empty, DefaultPort);

    // HTTP(S) bad-port list: https://fetch.spec.whatwg.org/#port-blocking
    private static readonly HashSet<int> BrowserBlockedPorts =
    [
        1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
        87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
        139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
        540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
        2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
        6679, 6697, 10080,
    ];

    internal static int ValidatePort(int port)
    {
        if (port is < 1 or > 65535)
            throw new InvalidOperationException("Server port must be a whole number from 1 to 65535.");
        if (BrowserBlockedPorts.Contains(port))
            throw new InvalidOperationException(
                $"Web browsers block port {port}. Choose a web-server port such as 8080 or 8787.");
        return port;
    }

    internal static int ParsePort(string? value)
    {
        if (!int.TryParse(value?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var port))
            throw new InvalidOperationException("Server port must be a whole number from 1 to 65535.");
        return ValidatePort(port);
    }

    internal static AppSettings Parse(ReadOnlyMemory<byte> bytes)
    {
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions
        {
            CommentHandling = JsonCommentHandling.Disallow,
            AllowTrailingCommas = false,
            MaxDepth = 8,
        });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("The OpenView settings file is invalid.");

        var photonUrl = root.TryGetProperty("photonApiUrl", out var photon)
            && photon.ValueKind == JsonValueKind.String
            ? InstallerEngine.ValidatePhotonUrl(photon.GetString())
            : string.Empty;
        var port = DefaultPort;
        if (root.TryGetProperty("port", out var property)
            && (property.ValueKind != JsonValueKind.Number || !property.TryGetInt32(out port)))
            throw new InvalidOperationException("The saved server port must be a whole number from 1 to 65535.");

        return new AppSettings(photonUrl, ValidatePort(port));
    }

    internal string Serialize()
    {
        var photonUrl = InstallerEngine.ValidatePhotonUrl(PhotonApiUrl);
        return JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            photonApiUrl = photonUrl.Length == 0 ? null : photonUrl,
            port = ValidatePort(Port),
        }, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine;
    }
}
