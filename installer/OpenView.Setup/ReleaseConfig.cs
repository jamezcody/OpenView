using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenView.Setup;

internal sealed class ArchiveDescriptor
{
    public string Name { get; init; } = "";
    public string Url { get; init; } = "";
    public string Sha256 { get; init; } = "";
    public long CompressedBytes { get; init; }
    public long FileCount { get; init; }
    public long UncompressedBytes { get; init; }
    public long MaximumCompressedBytes { get; init; }
    public long MaximumFileCount { get; init; }
    public long MaximumUncompressedBytes { get; init; }
}

internal sealed class RuntimeProbeDescriptor
{
    public string Path { get; init; } = "";
    public string Sha256 { get; init; } = "";
}

internal sealed class ReleaseManifest
{
    public int SchemaVersion { get; init; }
    public string Version { get; init; } = "";
    public string Tag { get; init; } = "";
    public string Repository { get; init; } = "";
    public ArchiveDescriptor RuntimeArchive { get; init; } = new();
    public ArchiveDescriptor DataArchive { get; init; } = new();
    public RuntimeProbeDescriptor RuntimeProbe { get; init; } = new();
    public string[] DataDirectories { get; init; } = [];
}

internal static partial class ReleaseConfig
{
    public const string ManifestResourceName = "OpenView.Setup.release.release-manifest.json";
    private static readonly Lazy<(ReleaseManifest Manifest, string Sha256)> Loaded = new(Load);

    public static ReleaseManifest Current => Loaded.Value.Manifest;
    public static string ManifestSha256 => Loaded.Value.Sha256;

    private static (ReleaseManifest, string) Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ManifestResourceName)
            ?? throw new InvalidOperationException("The embedded release manifest is missing.");
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        if (memory.Length is 0 or > 1024 * 1024)
            throw new InvalidOperationException("The embedded release manifest has an invalid size.");

        var bytes = memory.ToArray();
        var manifest = JsonSerializer.Deserialize<ReleaseManifest>(bytes, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        }) ?? throw new InvalidOperationException("The embedded release manifest is invalid.");
        Validate(manifest);
        return (manifest, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
    }

    internal static void Validate(ReleaseManifest manifest)
    {
        if (manifest.SchemaVersion != 1)
            throw new InvalidOperationException("The release manifest schema is unsupported.");
        if (!ReleaseVersion().IsMatch(manifest.Version)
            || string.IsNullOrWhiteSpace(manifest.Tag)
            || string.IsNullOrWhiteSpace(manifest.Repository))
            throw new InvalidOperationException("The release manifest identity is incomplete.");
        if (manifest.Repository != "jamezcody/openview-earth"
            || manifest.Tag != $"v{manifest.Version}")
            throw new InvalidOperationException("The release manifest repository or tag is invalid.");

        ValidateArchive(manifest.RuntimeArchive, "runtime", manifest);
        ValidateArchive(manifest.DataArchive, "data", manifest);
        if (string.Equals(manifest.RuntimeArchive.Name, manifest.DataArchive.Name, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The runtime and data archives must have distinct names.");
        if (manifest.DataDirectories.Length == 0
            || manifest.DataDirectories.Distinct(StringComparer.OrdinalIgnoreCase).Count() != manifest.DataDirectories.Length
            || manifest.DataDirectories.Any(value => !IsSafeSegment(value)))
            throw new InvalidOperationException("The release data-directory list is invalid.");

        var probe = manifest.RuntimeProbe;
        if (!IsSha256(probe.Sha256)
            || string.IsNullOrWhiteSpace(probe.Path)
            || !ProbePath().IsMatch(probe.Path)
            || !probe.Path.StartsWith("/", StringComparison.Ordinal)
            || probe.Path.StartsWith("//", StringComparison.Ordinal)
            || probe.Path.Contains("//", StringComparison.Ordinal)
            || probe.Path.EndsWith("/", StringComparison.Ordinal)
            || probe.Path.Contains('\\')
            || probe.Path.Contains('?')
            || probe.Path.Contains('#')
            || probe.Path.Split('/', StringSplitOptions.RemoveEmptyEntries).Any(part => part is "." or ".."))
            throw new InvalidOperationException("The release runtime probe is invalid.");
    }

    private static void ValidateArchive(ArchiveDescriptor archive, string label, ReleaseManifest manifest)
    {
        if (string.IsNullOrWhiteSpace(archive.Name)
            || archive.Name != Path.GetFileName(archive.Name)
            || !archive.Name.StartsWith("openview-", StringComparison.Ordinal)
            || !archive.Name.EndsWith(".tar.gz", StringComparison.Ordinal)
            || archive.Name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new InvalidOperationException($"The release {label} archive name is invalid.");
        if (!Uri.TryCreate(archive.Url, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment)
            || !string.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase)
            || !uri.IsDefaultPort
            || uri.AbsolutePath !=
                $"/{manifest.Repository}/releases/download/{manifest.Tag}/{archive.Name}")
            throw new InvalidOperationException($"The release {label} archive URL is invalid.");
        if (!IsSha256(archive.Sha256))
            throw new InvalidOperationException($"The release {label} archive checksum is invalid.");
        if (archive.CompressedBytes <= 0
            || archive.FileCount <= 0
            || archive.UncompressedBytes <= 0
            || archive.MaximumCompressedBytes <= 0
            || archive.MaximumFileCount <= 0
            || archive.MaximumUncompressedBytes <= 0
            || archive.CompressedBytes > archive.MaximumCompressedBytes
            || archive.FileCount > archive.MaximumFileCount
            || archive.UncompressedBytes > archive.MaximumUncompressedBytes)
            throw new InvalidOperationException($"The release {label} archive limits are invalid.");
    }

    internal static bool IsSha256(string value) =>
        value.Length == 64 && value.All(Uri.IsHexDigit);

    private static bool IsSafeSegment(string value) =>
        value.Length is > 0 and <= 64
        && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_')
        && value is not "." and not "..";

    [System.Text.RegularExpressions.GeneratedRegex("^[0-9]+\\.[0-9]+\\.[0-9]+$",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant)]
    private static partial System.Text.RegularExpressions.Regex ReleaseVersion();

    [System.Text.RegularExpressions.GeneratedRegex("^/[A-Za-z0-9._/-]+$",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant)]
    private static partial System.Text.RegularExpressions.Regex ProbePath();
}
