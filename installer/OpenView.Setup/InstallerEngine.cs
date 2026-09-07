using System.Diagnostics;
using System.Formats.Tar;
using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace OpenView.Setup;

internal sealed record InstallOptions(
    string InstallDirectory,
    string? PhotonApiUrl,
    bool AcceptanceTest = false,
    int Port = AppSettings.DefaultPort,
    bool DesktopLauncher = false,
    bool DesktopBrowser = false);
internal sealed record InstallResult(string InstallDirectory, IReadOnlyList<string> Warnings);
internal enum ArchiveKind { Runtime, Data }

internal sealed class InstallMarker
{
    public int SchemaVersion { get; init; }
    public string ProductId { get; init; } = "";
    public string Version { get; init; } = "";
    public string ManifestSha256 { get; init; } = "";
    public string RuntimeArchiveSha256 { get; init; } = "";
    public string DataArchiveSha256 { get; init; } = "";
    public DateTimeOffset InstalledAt { get; init; }
}

internal static partial class InstallerEngine
{
    internal const string ProductId = "com.jamezcody.openview";
    internal const string MarkerName = "openview-install.json";
    internal const string InstalledExecutableName = "OpenView.exe";
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenView";
    private const int CopyBufferBytes = 1024 * 1024;

    public static string DefaultInstallDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs", "OpenView");

    public static string UserDataDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenView");

    public static string SettingsPath => Path.Combine(UserDataDirectory, "config", "settings.json");

    public static string DiscoverInstallDirectory()
    {
        try
        {
            var baseDirectory = ValidateInstallDirectory(AppContext.BaseDirectory);
            if (IsOwnedInstallation(baseDirectory)) return baseDirectory;
        }
        catch { }

        var registered = GetRegisteredOwnedInstallationDirectory();
        if (registered is not null) return registered;
        return DefaultInstallDirectory;
    }

    public static bool IsInstalled(string directory)
    {
        try { ValidateInstalledLayout(directory); return true; }
        catch { return false; }
    }

    public static async Task<InstallResult> InstallAsync(
        InstallOptions options,
        IProgress<string> progress,
        CancellationToken cancellationToken)
    {
        var settings = new AppSettings(ValidatePhotonUrl(options.PhotonApiUrl), AppSettings.ValidatePort(options.Port));
        var manifest = ReleaseConfig.Current;
        var target = ValidateInstallDirectory(options.InstallDirectory);
        if (options.AcceptanceTest)
            ValidateAcceptanceTarget(target);
        else
        {
            var registeredTarget = GetRegisteredOwnedInstallationDirectory();
            if (registeredTarget is not null && !PathsEqual(target, registeredTarget))
                throw new InvalidOperationException(
                    $"OpenView is already installed at {registeredTarget}. Repair that location or uninstall it before choosing another folder.");
        }
        var executable = Path.GetFullPath(Environment.ProcessPath
            ?? throw new InvalidOperationException("The setup executable path is unavailable."));
        if (IsPathInside(executable, target))
            throw new InvalidOperationException(
                "An installed copy cannot replace itself. Run the downloaded setup executable to repair or update OpenView.");

        var parent = Directory.GetParent(target)?.FullName
            ?? throw new InvalidOperationException("Choose an installation folder below a drive root.");
        EnsureNoReparsePointsThrough(parent);
        Directory.CreateDirectory(parent);
        EnsureNoReparsePointsThrough(parent);
        EnsureFreeSpace(parent, manifest);
        await Task.Run(() => EnsureReplaceableTarget(target), cancellationToken);
        _ = await FindNodeAsync(cancellationToken);

        var operation = Path.Combine(parent, $".OpenView-operation-{Guid.NewGuid():N}");
        var runtimeArchive = Path.Combine(operation, manifest.RuntimeArchive.Name);
        var dataArchive = Path.Combine(operation, manifest.DataArchive.Name);
        var staging = Path.Combine(operation, "staging");
        var dataStaging = Path.Combine(operation, "data");
        var backup = Path.Combine(operation, "backup");
        var targetMoved = false;
        var activated = false;
        var warnings = new List<string>();

        Directory.CreateDirectory(operation);
        try
        {
            progress.Report("Acquiring the verified application runtime...");
            await AcquireArchiveAsync(manifest.RuntimeArchive, runtimeArchive, progress, cancellationToken);
            progress.Report("Acquiring the verified offline datasets...");
            await AcquireArchiveAsync(manifest.DataArchive, dataArchive, progress, cancellationToken);

            cancellationToken.ThrowIfCancellationRequested();
            progress.Report("Validating and extracting the application runtime...");
            Directory.CreateDirectory(staging);
            await Task.Run(
                () =>
                {
                    InspectArchive(runtimeArchive, manifest.RuntimeArchive, ArchiveKind.Runtime, staging, cancellationToken);
                    EnsureNoReparseTree(staging);
                },
                cancellationToken);

            progress.Report("Validating and extracting the offline datasets...");
            Directory.CreateDirectory(dataStaging);
            await Task.Run(() =>
            {
                InspectArchive(dataArchive, manifest.DataArchive, ArchiveKind.Data, dataStaging, cancellationToken);
                EnsureNoReparseTree(dataStaging);
                MergeDataIntoRuntime(dataStaging, staging, manifest);
                EnsureNoReparseTree(staging);
            }, cancellationToken);

            File.Copy(executable, Path.Combine(staging, InstalledExecutableName), false);
            WriteMarker(staging, manifest);
            ValidateInstalledLayout(staging);

            cancellationToken.ThrowIfCancellationRequested();
            progress.Report("Activating the installation...");
            await Task.Run(() =>
            {
                var controllerExclusion = LauncherForm.AcquireControllerExclusion();
                try
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    EnsureReplaceableTarget(target);
                    cancellationToken.ThrowIfCancellationRequested();
                    if (Directory.Exists(target))
                    {
                        Directory.Move(target, backup);
                        targetMoved = true;
                    }
                    Directory.Move(staging, target);
                    activated = true;
                    ValidateInstalledLayout(target);
                }
                finally { LauncherForm.ReleaseControllerExclusion(controllerExclusion); }
            }, cancellationToken);

            if (!options.AcceptanceTest)
            {
                progress.Report("Saving local configuration...");
                try { await WriteSettingsAsync(settings, cancellationToken); }
                catch (Exception error) { warnings.Add($"Settings were not saved: {error.Message}"); }
                try { CreateStartMenuShortcut(target); }
                catch (Exception error) { warnings.Add($"The Start menu shortcut was not created: {error.Message}"); }
                var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                if (options.DesktopLauncher)
                {
                    try { ShellShortcuts.Create(desktop, target, browser: false); }
                    catch (Exception error) { warnings.Add($"The desktop launcher shortcut was not created: {error.Message}"); }
                }
                if (options.DesktopBrowser)
                {
                    try { ShellShortcuts.Create(desktop, target, browser: true); }
                    catch (Exception error) { warnings.Add($"The desktop browser shortcut was not created: {error.Message}"); }
                }
                try { RegisterUninstaller(target); }
                catch (Exception error) { warnings.Add($"Windows app registration was not updated: {error.Message}"); }
            }

            if (targetMoved)
            {
                progress.Report("Removing the previous installation...");
                var cleanup = await Task.Run(() =>
                {
                    var deleted = TrySafeDeleteDirectory(backup, out var error);
                    return (deleted, error);
                });
                if (!cleanup.deleted)
                    warnings.Add($"The previous installation remains at {backup}: {cleanup.error}");
            }

            progress.Report($"OpenView {manifest.Version} is installed.");
            return new InstallResult(target, warnings);
        }
        catch (Exception installError)
        {
            var rollbackErrors = new List<Exception>();
            if (activated && Directory.Exists(target))
            {
                var removal = await Task.Run(() =>
                {
                    var deleted = TrySafeDeleteDirectory(target, out var error);
                    return (deleted, error);
                });
                if (!removal.deleted)
                    rollbackErrors.Add(new IOException(
                        $"The incomplete target remains at {target}: {removal.error}"));
            }
            if (targetMoved && !Directory.Exists(target) && Directory.Exists(backup))
            {
                try { Directory.Move(backup, target); }
                catch (Exception restoreError) { rollbackErrors.Add(restoreError); }
            }
            if (rollbackErrors.Count != 0)
                throw new AggregateException(
                    $"Installation failed and rollback needs attention. A previous installation, if any, is retained at {backup}.",
                    [installError, ..rollbackErrors]);
            throw;
        }
        finally
        {
            // Never remove an operation directory while it still contains the only known-good backup.
            if (Directory.Exists(operation) && !Directory.Exists(backup))
                await Task.Run(() => TrySafeDeleteDirectory(operation, out _));
        }
    }

    public static string ValidatePhotonUrl(string? value)
    {
        var candidate = value?.Trim() ?? string.Empty;
        if (candidate.Length == 0) return string.Empty;
        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps
            || !string.IsNullOrEmpty(uri.UserInfo)
            || string.IsNullOrWhiteSpace(uri.Host)
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment))
            throw new InvalidOperationException(
                "PHOTON_API_URL must be an absolute HTTPS URL without credentials, query parameters, or a fragment.");
        return uri.AbsoluteUri;
    }

    public static AppSettings LoadSettings()
    {
        if (!File.Exists(SettingsPath)) return AppSettings.Default;
        EnsureNoReparsePointsThrough(SettingsPath);
        var info = new FileInfo(SettingsPath);
        if (info.Length is < 1 or > 64 * 1024)
            throw new InvalidOperationException("The OpenView settings file has an invalid size.");
        return AppSettings.Parse(File.ReadAllBytes(SettingsPath));
    }

    public static async Task WriteSettingsAsync(AppSettings settings, CancellationToken cancellationToken)
    {
        var content = settings.Serialize();
        var directory = Path.GetDirectoryName(SettingsPath)!;
        EnsureNoReparsePointsThrough(directory);
        Directory.CreateDirectory(directory);
        EnsureNoReparsePointsThrough(directory);
        EnsureNoReparsePointsThrough(SettingsPath);
        var temporary = Path.Combine(directory, $"settings-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllTextAsync(temporary, content, cancellationToken);
            EnsureNoReparsePointsThrough(SettingsPath);
            File.Move(temporary, SettingsPath, true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    internal static string ValidateInstallDirectory(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new InvalidOperationException("Choose an installation directory.");
        var expanded = Environment.ExpandEnvironmentVariables(value.Trim().Trim('"'));
        if (!Path.IsPathFullyQualified(expanded) || expanded.StartsWith("\\\\", StringComparison.Ordinal))
            throw new InvalidOperationException("Choose a fully qualified local installation directory.");
        var full = Path.GetFullPath(expanded).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var root = Path.GetPathRoot(full)?.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (full.Length < 4 || string.Equals(full, root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("A drive root cannot be used as the installation directory.");

        string[] broadDirectories =
        [
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
        ];
        if (broadDirectories.Any(path => !string.IsNullOrEmpty(path)
            && PathsEqual(full, Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar))))
            throw new InvalidOperationException("Choose a dedicated OpenView subdirectory.");
        if (PathsOverlap(full, UserDataDirectory))
            throw new InvalidOperationException("The installation directory cannot overlap OpenView's settings directory.");
        EnsureNoReparsePointsThrough(full);
        return full;
    }

    private static void ValidateAcceptanceTarget(string target)
    {
        var temporaryRoot = Path.GetFullPath(Path.GetTempPath())
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var parent = Directory.GetParent(target)?.FullName ?? string.Empty;
        if (!PathsEqual(parent, temporaryRoot)
            || !Path.GetFileName(target).StartsWith("OpenView-Acceptance-", StringComparison.Ordinal)
            || Directory.Exists(target)
            || File.Exists(target))
            throw new InvalidOperationException(
                "Acceptance installs require a new OpenView-Acceptance-* directory directly below the Windows temporary directory.");
    }

    internal static void ValidateInstalledLayout(string directory)
    {
        var target = ValidateInstallDirectory(directory);
        ValidateOwnedInstallationStructure(target);
        var marker = ReadOwnedMarker(target);
        var manifest = ReleaseConfig.Current;
        if (marker.Version != manifest.Version
            || !HashesEqual(marker.ManifestSha256, ReleaseConfig.ManifestSha256)
            || !HashesEqual(marker.RuntimeArchiveSha256, manifest.RuntimeArchive.Sha256)
            || !HashesEqual(marker.DataArchiveSha256, manifest.DataArchive.Sha256))
            throw new InvalidOperationException("The OpenView installation marker does not match this release.");

        var favicon = CombineUnderRoot(target, "dist/client/favicon.svg");
        using var file = File.OpenRead(favicon);
        var actual = Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant();
        if (!HashesEqual(actual, manifest.RuntimeProbe.Sha256))
            throw new InvalidOperationException("The installed runtime probe does not match the release manifest.");
    }

    internal static bool TryReadOwnedMarker(string directory, out InstallMarker? marker)
    {
        try { marker = ReadOwnedMarker(ValidateInstallDirectory(directory)); return true; }
        catch { marker = null; return false; }
    }

    private static InstallMarker ReadOwnedMarker(string target)
    {
        var markerPath = CombineUnderRoot(target, MarkerName);
        EnsureNoReparsePointsThrough(markerPath);
        if (!File.Exists(markerPath))
            throw new InvalidOperationException("The directory is not an OpenView installation.");
        var info = new FileInfo(markerPath);
        if (info.Length is < 2 or > 64 * 1024)
            throw new InvalidOperationException("The OpenView installation marker has an invalid size.");
        var marker = JsonSerializer.Deserialize<InstallMarker>(File.ReadAllBytes(markerPath), new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        }) ?? throw new InvalidOperationException("The OpenView installation marker is invalid.");
        if (marker.SchemaVersion != 1 || marker.ProductId != ProductId
            || string.IsNullOrWhiteSpace(marker.Version)
            || !ReleaseConfig.IsSha256(marker.ManifestSha256)
            || !ReleaseConfig.IsSha256(marker.RuntimeArchiveSha256)
            || !ReleaseConfig.IsSha256(marker.DataArchiveSha256))
            throw new InvalidOperationException("The directory does not contain a valid OpenView ownership marker.");
        return marker;
    }

    private static void WriteMarker(string target, ReleaseManifest manifest)
    {
        var marker = new InstallMarker
        {
            SchemaVersion = 1,
            ProductId = ProductId,
            Version = manifest.Version,
            ManifestSha256 = ReleaseConfig.ManifestSha256,
            RuntimeArchiveSha256 = manifest.RuntimeArchive.Sha256,
            DataArchiveSha256 = manifest.DataArchive.Sha256,
            InstalledAt = DateTimeOffset.UtcNow,
        };
        File.WriteAllText(CombineUnderRoot(target, MarkerName),
            JsonSerializer.Serialize(marker, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine);
    }

    private static void EnsureReplaceableTarget(string target)
    {
        if (!Directory.Exists(target)) return;
        EnsureNoReparsePointsThrough(target);
        if (!Directory.EnumerateFileSystemEntries(target).Any()) return;
        ValidateOwnedInstallationStructure(target);
        EnsureNoReparseTree(target);
        if (LauncherForm.IsControllerActive())
            throw new InvalidOperationException(
                "Close the OpenView controller before repairing or updating the installation.");
    }

    private static bool IsOwnedInstallation(string target)
    {
        try { ValidateOwnedInstallationStructure(target); return true; }
        catch { return false; }
    }

    private static string? GetRegisteredOwnedInstallationDirectory()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(UninstallKey, false);
            if (key?.GetValue("InstallLocation") is not string value) return null;
            var target = ValidateInstallDirectory(value);
            return IsOwnedInstallation(target) ? target : null;
        }
        catch { return null; }
    }

    private static void ValidateOwnedInstallationStructure(string target)
    {
        target = ValidateInstallDirectory(target);
        EnsureNoReparsePointsThrough(target);
        _ = ReadOwnedMarker(target);
        var manifest = ReleaseConfig.Current;
        string[] required =
        [
            InstalledExecutableName,
            "dist/server/wrangler.json",
            "dist/client/favicon.svg",
            "node_modules/wrangler/bin/wrangler.js",
            ..manifest.DataDirectories.Select(name => $"dist/client/{name}/latest.json"),
        ];
        foreach (var relative in required)
        {
            var path = CombineUnderRoot(target, relative);
            EnsureNoReparsePointsThrough(path);
            if (!File.Exists(path))
                throw new InvalidOperationException($"The OpenView installation is missing {relative}.");
        }
    }

    private static void EnsureFreeSpace(string parent, ReleaseManifest manifest)
    {
        var root = Path.GetPathRoot(parent)
            ?? throw new InvalidOperationException("The installation drive is unavailable.");
        var drive = new DriveInfo(root);
        var required = checked(manifest.RuntimeArchive.CompressedBytes
            + manifest.DataArchive.CompressedBytes
            + manifest.RuntimeArchive.UncompressedBytes
            + manifest.DataArchive.UncompressedBytes
            + 512L * 1024 * 1024);
        if (drive.AvailableFreeSpace < required)
            throw new InvalidOperationException($"At least {Math.Ceiling(required / 1073741824d):N0} GB of free space is required during installation.");
    }

    private static async Task AcquireArchiveAsync(
        ArchiveDescriptor descriptor,
        string destination,
        IProgress<string> progress,
        CancellationToken cancellationToken)
    {
        var sidecar = Path.Combine(AppContext.BaseDirectory, descriptor.Name);
        if (File.Exists(sidecar))
        {
            progress.Report($"Verifying local {descriptor.Name}...");
            await CopyAndVerifyAsync(sidecar, destination, descriptor, cancellationToken);
            return;
        }

        using var handler = new HttpClientHandler
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 8,
            AutomaticDecompression = DecompressionMethods.None,
        };
        using var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        client.DefaultRequestHeaders.UserAgent.ParseAdd($"OpenView-Setup/{ReleaseConfig.Current.Version}");
        using var response = await client.GetAsync(descriptor.Url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        var finalUri = response.RequestMessage?.RequestUri;
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Downloading {descriptor.Name} failed with HTTP {(int)response.StatusCode}.");
        if (finalUri?.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException($"Downloading {descriptor.Name} redirected to a non-HTTPS address.");
        if (response.Content.Headers.ContentLength is long length && length != descriptor.CompressedBytes)
            throw new InvalidOperationException($"The server reported an unexpected size for {descriptor.Name}.");

        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await CopyStreamAndVerifyAsync(input, destination, descriptor, progress, cancellationToken);
    }

    private static async Task CopyAndVerifyAsync(
        string source,
        string destination,
        ArchiveDescriptor descriptor,
        CancellationToken cancellationToken)
    {
        if (new FileInfo(source).Length != descriptor.CompressedBytes)
            throw new InvalidOperationException($"The local {descriptor.Name} has an unexpected size.");
        await using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read,
            CopyBufferBytes, FileOptions.Asynchronous | FileOptions.SequentialScan);
        await CopyStreamAndVerifyAsync(input, destination, descriptor, null, cancellationToken);
    }

    private static async Task CopyStreamAndVerifyAsync(
        Stream input,
        string destination,
        ArchiveDescriptor descriptor,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None,
            CopyBufferBytes, FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[CopyBufferBytes];
        long total = 0;
        long nextReport = 32L * 1024 * 1024;
        while (true)
        {
            var read = await input.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            total = checked(total + read);
            if (total > descriptor.CompressedBytes || total > descriptor.MaximumCompressedBytes)
                throw new InvalidOperationException($"{descriptor.Name} exceeds its release size limit.");
            hash.AppendData(buffer, 0, read);
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            if (progress is not null && total >= nextReport)
            {
                progress.Report($"Downloading {descriptor.Name}... {total / 1048576:N0} MiB");
                nextReport += 32L * 1024 * 1024;
            }
        }
        await output.FlushAsync(cancellationToken);
        var actual = hash.GetHashAndReset();
        var expected = Convert.FromHexString(descriptor.Sha256);
        if (total != descriptor.CompressedBytes || !CryptographicOperations.FixedTimeEquals(actual, expected))
            throw new InvalidOperationException($"{descriptor.Name} failed release size or SHA-256 verification.");
    }

    internal static void VerifyArchiveFile(
        string archivePath,
        ArchiveDescriptor descriptor,
        ArchiveKind kind,
        CancellationToken cancellationToken = default)
    {
        InspectArchive(archivePath, descriptor, kind, null, cancellationToken);
    }

    private static void InspectArchive(
        string archivePath,
        ArchiveDescriptor descriptor,
        ArchiveKind kind,
        string? extractionRoot,
        CancellationToken cancellationToken)
    {
        var manifest = ReleaseConfig.Current;
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var requiredAsDirectory = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var canonicalCasing = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var pointers = new HashSet<string>(StringComparer.Ordinal);
        var requiredRuntime = new HashSet<string>(StringComparer.Ordinal)
        {
            "dist/server/wrangler.json",
            "dist/client/favicon.svg",
            "node_modules/wrangler/bin/wrangler.js",
        };
        var probePath = "dist/client/" + manifest.RuntimeProbe.Path.TrimStart('/');
        var sawProbe = false;
        long fileCount = 0;
        long uncompressedBytes = 0;
        long entryCount = 0;
        var maximumEntries = checked(descriptor.MaximumFileCount * 2 + 4096);

        using var file = new FileStream(archivePath, FileMode.Open, FileAccess.Read, FileShare.None,
            CopyBufferBytes, FileOptions.SequentialScan);
        if (file.Length != descriptor.CompressedBytes || file.Length > descriptor.MaximumCompressedBytes)
            throw new InvalidOperationException($"{descriptor.Name} has an unexpected compressed size.");
        var compressedHash = SHA256.HashData(file);
        CheckHash(compressedHash, descriptor.Sha256,
            $"{descriptor.Name} failed SHA-256 verification.");
        file.Position = 0;
        ValidateRawTar(file, descriptor, kind, manifest, cancellationToken);
        file.Position = 0;
        using var gzip = new GZipStream(file, CompressionMode.Decompress, true);
        using var reader = new TarReader(gzip, false);
        while (reader.GetNextEntry(copyData: false) is { } entry)
        {
            cancellationToken.ThrowIfCancellationRequested();
            entryCount++;
            if (entryCount > maximumEntries)
                throw new InvalidOperationException($"{descriptor.Name} contains too many entries.");
            var name = NormalizeArchivePath(entry.Name, entry.EntryType == TarEntryType.Directory);
            if (!names.Add(name))
                throw new InvalidOperationException($"{descriptor.Name} contains a duplicate or case-colliding path: {name}");
            EnsureCanonicalCasing(canonicalCasing, name, descriptor.Name);
            var isFile = entry.EntryType is TarEntryType.RegularFile or TarEntryType.V7RegularFile;
            if (!isFile && entry.EntryType != TarEntryType.Directory)
                throw new InvalidOperationException($"{descriptor.Name} contains a prohibited TAR entry type: {name}");
            if (entry is PaxTarEntry pax
                && (pax.ExtendedAttributes.Count != 1
                    || !pax.ExtendedAttributes.TryGetValue("path", out var paxPath)
                    || !string.Equals(paxPath, entry.Name, StringComparison.Ordinal)))
                throw new InvalidOperationException($"{descriptor.Name} contains unexpected PAX metadata: {name}");

            ValidateArchiveScope(name, isFile, kind, manifest);
            foreach (var parent in EnumerateParents(name))
            {
                EnsureCanonicalCasing(canonicalCasing, parent, descriptor.Name);
                if (files.Contains(parent))
                    throw new InvalidOperationException($"{descriptor.Name} places an entry below a file: {name}");
                requiredAsDirectory.Add(parent);
            }
            if (isFile && requiredAsDirectory.Contains(name))
                throw new InvalidOperationException($"{descriptor.Name} uses a file where a directory is required: {name}");

            var destination = extractionRoot is null ? null : CombineUnderRoot(extractionRoot, name);
            if (!isFile)
            {
                if (entry.Length != 0)
                    throw new InvalidOperationException($"{descriptor.Name} has data attached to a directory: {name}");
                if (destination is not null) Directory.CreateDirectory(destination);
                continue;
            }

            files.Add(name);
            fileCount++;
            if (fileCount > descriptor.MaximumFileCount)
                throw new InvalidOperationException($"{descriptor.Name} contains too many files.");
            uncompressedBytes = checked(uncompressedBytes + entry.Length);
            if (uncompressedBytes > descriptor.MaximumUncompressedBytes)
                throw new InvalidOperationException($"{descriptor.Name} exceeds its uncompressed size limit.");
            requiredRuntime.Remove(name);
            if (kind == ArchiveKind.Data)
            {
                foreach (var directory in manifest.DataDirectories)
                    if (name == $"public/{directory}/latest.json") pointers.Add(directory);
            }

            var data = entry.DataStream;
            if (data is null && entry.Length != 0)
                throw new InvalidOperationException($"{descriptor.Name} contains a file without data: {name}");
            data ??= Stream.Null;
            if (destination is not null)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                    CopyBufferBytes, FileOptions.SequentialScan);
                CopyExactly(data, output, entry.Length, cancellationToken,
                    kind == ArchiveKind.Runtime && name == probePath ? manifest.RuntimeProbe.Sha256 : null);
                if (kind == ArchiveKind.Runtime && name == probePath) sawProbe = true;
            }
            else if (kind == ArchiveKind.Runtime && name == probePath)
            {
                HashExactly(data, entry.Length, manifest.RuntimeProbe.Sha256, cancellationToken);
                sawProbe = true;
            }
        }

        if (fileCount != descriptor.FileCount || uncompressedBytes != descriptor.UncompressedBytes)
            throw new InvalidOperationException($"{descriptor.Name} does not match its declared file count or uncompressed size.");
        if (kind == ArchiveKind.Runtime && (requiredRuntime.Count != 0 || !sawProbe))
            throw new InvalidOperationException("The runtime archive is incomplete.");
        if (kind == ArchiveKind.Data && pointers.Count != manifest.DataDirectories.Length)
            throw new InvalidOperationException("The data archive is incomplete.");
    }

    private static void ValidateRawTar(
        FileStream compressedFile,
        ArchiveDescriptor descriptor,
        ArchiveKind kind,
        ReleaseManifest manifest,
        CancellationToken cancellationToken)
    {
        using var gzip = new GZipStream(compressedFile, CompressionMode.Decompress, true);
        var header = new byte[512];
        var transfer = new byte[CopyBufferBytes];
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var requiredAsDirectory = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var canonicalCasing = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var maximumEntries = checked(descriptor.MaximumFileCount * 2 + 4096);
        var maximumTarBytes = checked(descriptor.MaximumUncompressedBytes
            + descriptor.MaximumFileCount * 5120
            + maximumEntries * 512
            + 1024);
        long tarBytes = 0;
        long entryCount = 0;
        long fileCount = 0;
        long uncompressedBytes = 0;
        string? pendingPaxPath = null;
        string? pendingPayloadName = null;

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ReadTarBlock(gzip, header, ref tarBytes, maximumTarBytes);
            if (header.All(value => value == 0))
            {
                if (pendingPaxPath is not null)
                    throw new InvalidOperationException($"{descriptor.Name} contains dangling PAX metadata.");
                ReadTarBlock(gzip, header, ref tarBytes, maximumTarBytes);
                if (header.Any(value => value != 0))
                    throw new InvalidOperationException($"{descriptor.Name} has an invalid TAR end marker.");
                var trailing = gzip.ReadByte();
                if (trailing != -1)
                    throw new InvalidOperationException($"{descriptor.Name} has trailing decompressed TAR content.");
                break;
            }

            entryCount++;
            if (entryCount > maximumEntries)
                throw new InvalidOperationException($"{descriptor.Name} contains too many TAR records.");
            ValidateTarHeaderChecksum(header, descriptor.Name);
            if (!header.AsSpan(257, 6).SequenceEqual("ustar\0"u8)
                || !header.AsSpan(263, 2).SequenceEqual("00"u8))
                throw new InvalidOperationException($"{descriptor.Name} contains a non-USTAR header.");

            var rawName = DecodeTarText(header.AsSpan(0, 100), descriptor.Name);
            var prefix = DecodeTarText(header.AsSpan(345, 155), descriptor.Name);
            if (prefix.Length != 0) rawName = prefix + "/" + rawName;
            var length = ParseTarOctal(header.AsSpan(124, 12), "size", descriptor.Name);
            var type = header[156];

            if (type == (byte)'x')
            {
                if (pendingPaxPath is not null || length is <= 0 or > 8192
                    || !PaxHeaderName().IsMatch(rawName))
                    throw new InvalidOperationException($"{descriptor.Name} contains invalid PAX metadata.");
                var identifier = rawName["PaxHeaders/openview-".Length..];
                var payload = new byte[checked((int)length)];
                ReadTarBytes(gzip, payload, ref tarBytes, maximumTarBytes);
                ReadTarPadding(gzip, length, transfer, ref tarBytes, maximumTarBytes);
                pendingPaxPath = NormalizeArchivePath(ParseSinglePaxPath(payload, descriptor.Name), false);
                pendingPayloadName = "PaxPayload/openview-" + identifier;
                continue;
            }

            var isFile = type is 0 or (byte)'0';
            var isDirectory = type == (byte)'5';
            if (!isFile && !isDirectory)
                throw new InvalidOperationException($"{descriptor.Name} contains a prohibited raw TAR type.");
            if (pendingPaxPath is not null)
            {
                if (!isFile || rawName != pendingPayloadName)
                    throw new InvalidOperationException($"{descriptor.Name} does not pair PAX metadata with its file.");
                rawName = pendingPaxPath;
                pendingPaxPath = null;
                pendingPayloadName = null;
            }

            var name = NormalizeArchivePath(rawName, isDirectory);
            if (!names.Add(name))
                throw new InvalidOperationException($"{descriptor.Name} contains a duplicate or case-colliding path: {name}");
            EnsureCanonicalCasing(canonicalCasing, name, descriptor.Name);
            ValidateArchiveScope(name, isFile, kind, manifest);
            foreach (var parent in EnumerateParents(name))
            {
                EnsureCanonicalCasing(canonicalCasing, parent, descriptor.Name);
                if (files.Contains(parent))
                    throw new InvalidOperationException($"{descriptor.Name} places an entry below a file: {name}");
                requiredAsDirectory.Add(parent);
            }
            if (isFile && requiredAsDirectory.Contains(name))
                throw new InvalidOperationException($"{descriptor.Name} uses a file where a directory is required: {name}");
            if (isDirectory && length != 0)
                throw new InvalidOperationException($"{descriptor.Name} has data attached to a directory: {name}");
            if (isFile)
            {
                files.Add(name);
                fileCount++;
                uncompressedBytes = checked(uncompressedBytes + length);
                if (fileCount > descriptor.MaximumFileCount
                    || uncompressedBytes > descriptor.MaximumUncompressedBytes)
                    throw new InvalidOperationException($"{descriptor.Name} exceeds its file or byte limit.");
            }
            SkipTarBytes(gzip, length, transfer, ref tarBytes, maximumTarBytes, cancellationToken);
            ReadTarPadding(gzip, length, transfer, ref tarBytes, maximumTarBytes);
        }

        if (fileCount != descriptor.FileCount || uncompressedBytes != descriptor.UncompressedBytes)
            throw new InvalidOperationException(
                $"{descriptor.Name} does not match its declared raw TAR file count or byte size.");
    }

    private static void ReadTarBlock(Stream input, byte[] block, ref long total, long maximum)
    {
        Array.Clear(block);
        ReadTarBytes(input, block, ref total, maximum);
    }

    private static void ReadTarBytes(Stream input, byte[] destination, ref long total, long maximum)
    {
        var offset = 0;
        while (offset < destination.Length)
        {
            var read = input.Read(destination, offset, destination.Length - offset);
            if (read == 0) throw new InvalidOperationException("A compressed TAR stream ended unexpectedly.");
            offset += read;
            total = checked(total + read);
            if (total > maximum) throw new InvalidOperationException("A TAR stream exceeds its decompressed safety limit.");
        }
    }

    private static void SkipTarBytes(
        Stream input,
        long length,
        byte[] buffer,
        ref long total,
        long maximum,
        CancellationToken cancellationToken)
    {
        long remaining = length;
        while (remaining != 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var requested = (int)Math.Min(buffer.Length, remaining);
            var read = input.Read(buffer, 0, requested);
            if (read == 0) throw new InvalidOperationException("A TAR payload ended unexpectedly.");
            remaining -= read;
            total = checked(total + read);
            if (total > maximum) throw new InvalidOperationException("A TAR stream exceeds its decompressed safety limit.");
        }
    }

    private static void ReadTarPadding(Stream input, long length, byte[] buffer, ref long total, long maximum)
    {
        var padding = (int)((512 - (length % 512)) % 512);
        if (padding == 0) return;
        var bytes = buffer.AsSpan(0, padding);
        var offset = 0;
        while (offset < padding)
        {
            var read = input.Read(buffer, offset, padding - offset);
            if (read == 0) throw new InvalidOperationException("A TAR padding block ended unexpectedly.");
            offset += read;
            total = checked(total + read);
            if (total > maximum) throw new InvalidOperationException("A TAR stream exceeds its decompressed safety limit.");
        }
        if (!IsAllZero(bytes))
            throw new InvalidOperationException("A TAR payload has nonzero padding.");
    }

    private static void ValidateTarHeaderChecksum(ReadOnlySpan<byte> header, string archiveName)
    {
        var expected = ParseTarOctal(header.Slice(148, 8), "checksum", archiveName);
        long actual = 0;
        for (var index = 0; index < header.Length; index++)
            actual += index is >= 148 and < 156 ? 0x20 : header[index];
        if (actual != expected)
            throw new InvalidOperationException($"{archiveName} contains a TAR header with an invalid checksum.");
    }

    private static long ParseTarOctal(ReadOnlySpan<byte> field, string fieldName, string archiveName)
    {
        var start = 0;
        while (start < field.Length && field[start] == (byte)' ') start++;
        var end = start;
        while (end < field.Length && field[end] is >= (byte)'0' and <= (byte)'7') end++;
        if (end == start)
            throw new InvalidOperationException($"{archiveName} has an invalid TAR {fieldName} field.");
        for (var index = end; index < field.Length; index++)
            if (field[index] is not (0 or (byte)' '))
                throw new InvalidOperationException($"{archiveName} has an invalid TAR {fieldName} field.");
        long value = 0;
        for (var index = start; index < end; index++) value = checked(value * 8 + field[index] - (byte)'0');
        return value;
    }

    private static string DecodeTarText(ReadOnlySpan<byte> field, string archiveName)
    {
        var end = field.IndexOf((byte)0);
        if (end < 0) end = field.Length;
        else if (!IsAllZero(field[(end + 1)..]))
            throw new InvalidOperationException($"{archiveName} contains a malformed TAR text field.");
        try { return StrictUtf8().GetString(field[..end]); }
        catch (DecoderFallbackException)
        {
            throw new InvalidOperationException($"{archiveName} contains a non-UTF-8 TAR path.");
        }
    }

    private static string ParseSinglePaxPath(byte[] payload, string archiveName)
    {
        var space = Array.IndexOf(payload, (byte)' ');
        if (space <= 0 || payload.AsSpan(0, space).ContainsAnyExceptInRange((byte)'0', (byte)'9')
            || !long.TryParse(Encoding.ASCII.GetString(payload, 0, space), NumberStyles.None,
                CultureInfo.InvariantCulture, out var declared)
            || declared != payload.Length || payload[^1] != (byte)'\n')
            throw new InvalidOperationException($"{archiveName} contains a malformed PAX record.");
        ReadOnlySpan<byte> body = payload.AsSpan(space + 1, payload.Length - space - 2);
        if (!body.StartsWith("path="u8) || body[5..].Contains((byte)'\n'))
            throw new InvalidOperationException($"{archiveName} contains unknown or multiple PAX keys.");
        try { return StrictUtf8().GetString(body[5..]); }
        catch (DecoderFallbackException)
        {
            throw new InvalidOperationException($"{archiveName} contains a non-UTF-8 PAX path.");
        }
    }

    private static UTF8Encoding StrictUtf8() => new(false, true);

    private static bool IsAllZero(ReadOnlySpan<byte> bytes)
    {
        foreach (var value in bytes) if (value != 0) return false;
        return true;
    }

    internal static string NormalizeArchivePath(string rawName, bool directory)
    {
        if (string.IsNullOrEmpty(rawName) || rawName.Contains('\\') || rawName.Contains('\0'))
            throw new InvalidOperationException("An archive contains an invalid path.");
        var name = rawName;
        if (name.StartsWith("./", StringComparison.Ordinal))
        {
            name = name[2..];
            if (name.StartsWith("./", StringComparison.Ordinal))
                throw new InvalidOperationException("An archive path has more than one ./ prefix.");
        }
        if (directory && name.EndsWith("/", StringComparison.Ordinal)) name = name[..^1];
        if (name.Length is 0 or > 4096 || name.StartsWith("/", StringComparison.Ordinal)
            || name.EndsWith("/", StringComparison.Ordinal) || Path.IsPathRooted(name))
            throw new InvalidOperationException("An archive contains a rooted or empty path.");
        var parts = name.Split('/');
        foreach (var part in parts)
        {
            var stem = part.Split('.', 2)[0];
            if (part.Length is 0 or > 255 || part is "." or ".."
                || part.EndsWith(' ') || part.EndsWith('.')
                || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0
                || ReservedDeviceNames().IsMatch(stem))
                throw new InvalidOperationException($"An archive contains an unsafe Windows path: {rawName}");
        }
        return string.Join('/', parts);
    }

    private static void ValidateArchiveScope(string name, bool isFile, ArchiveKind kind, ReleaseManifest manifest)
    {
        var segments = name.Split('/');
        if (kind == ArchiveKind.Runtime)
        {
            if (segments[0] is not ("dist" or "node_modules") || (segments.Length == 1 && isFile))
                throw new InvalidOperationException($"The runtime archive contains an unexpected path: {name}");
            foreach (var directory in manifest.DataDirectories)
                if (name == $"dist/client/{directory}" || name.StartsWith($"dist/client/{directory}/", StringComparison.Ordinal))
                    throw new InvalidOperationException($"The runtime archive improperly contains dataset content: {name}");
            return;
        }

        if (segments.Length < 2 || segments[0] != "public"
            || !manifest.DataDirectories.Contains(segments[1], StringComparer.Ordinal)
            || (segments.Length == 2 && isFile))
            throw new InvalidOperationException($"The data archive contains an unexpected path: {name}");
    }

    private static IEnumerable<string> EnumerateParents(string path)
    {
        var index = path.IndexOf('/');
        while (index >= 0)
        {
            yield return path[..index];
            index = path.IndexOf('/', index + 1);
        }
    }

    private static void EnsureCanonicalCasing(
        Dictionary<string, string> canonicalCasing, string path, string archiveName)
    {
        if (canonicalCasing.TryGetValue(path, out var previous))
        {
            if (!string.Equals(previous, path, StringComparison.Ordinal))
                throw new InvalidOperationException(
                    $"{archiveName} contains a case-colliding path: {previous} and {path}");
            return;
        }
        canonicalCasing.Add(path, path);
    }

    private static void CopyExactly(
        Stream input, Stream output, long expectedLength, CancellationToken cancellationToken, string? expectedSha)
    {
        using var hash = expectedSha is null ? null : IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[CopyBufferBytes];
        long total = 0;
        while (total < expectedLength)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var read = input.Read(buffer, 0, (int)Math.Min(buffer.Length, expectedLength - total));
            if (read == 0) throw new InvalidOperationException("An archive file ended unexpectedly.");
            output.Write(buffer, 0, read);
            hash?.AppendData(buffer, 0, read);
            total += read;
        }
        if (expectedSha is not null)
            CheckHash(hash!.GetHashAndReset(), expectedSha, "The runtime probe failed SHA-256 verification.");
    }

    private static void HashExactly(Stream input, long length, string expectedSha, CancellationToken cancellationToken)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[CopyBufferBytes];
        long total = 0;
        while (total < length)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var read = input.Read(buffer, 0, (int)Math.Min(buffer.Length, length - total));
            if (read == 0) throw new InvalidOperationException("The runtime probe ended unexpectedly.");
            hash.AppendData(buffer, 0, read);
            total += read;
        }
        CheckHash(hash.GetHashAndReset(), expectedSha, "The runtime probe failed SHA-256 verification.");
    }

    private static void CheckHash(byte[] actual, string expectedHex, string message)
    {
        if (!CryptographicOperations.FixedTimeEquals(actual, Convert.FromHexString(expectedHex)))
            throw new InvalidOperationException(message);
    }

    private static void MergeDataIntoRuntime(string dataRoot, string runtimeRoot, ReleaseManifest manifest)
    {
        var client = CombineUnderRoot(runtimeRoot, "dist/client");
        if (!Directory.Exists(client))
            throw new InvalidOperationException("The runtime archive lacks dist/client.");
        foreach (var directory in manifest.DataDirectories)
        {
            var source = CombineUnderRoot(dataRoot, $"public/{directory}");
            var destination = CombineUnderRoot(client, directory);
            if (!Directory.Exists(source) || Directory.Exists(destination))
                throw new InvalidOperationException($"The {directory} dataset cannot be activated safely.");
            Directory.Move(source, destination);
            ValidateDatasetPointer(CombineUnderRoot(destination, "latest.json"), directory);
        }
        var publicRoot = CombineUnderRoot(dataRoot, "public");
        if (Directory.Exists(publicRoot) && Directory.EnumerateFileSystemEntries(publicRoot).Any())
            throw new InvalidOperationException("Unexpected data remained after dataset activation.");
    }

    private static void ValidateDatasetPointer(string path, string directory)
    {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length is < 2 or > 1024 * 1024)
            throw new InvalidOperationException($"The prepared {directory} pointer is invalid.");
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        if (document.RootElement.ValueKind != JsonValueKind.Object
            || !document.RootElement.EnumerateObject().Any())
            throw new InvalidOperationException($"The prepared {directory} pointer is invalid.");
    }

    internal static async Task<string> FindNodeAsync(CancellationToken cancellationToken)
    {
        var node = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Select(path => path.Trim().Trim('"'))
            .Select(path => Path.Combine(path, "node.exe"))
            .FirstOrDefault(File.Exists);
        if (node is null)
            throw new InvalidOperationException("Node.js 22.13 or newer was not found on PATH.");
        var start = new ProcessStartInfo(node, "--version")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        SanitizeEnvironment(start);
        using var process = Process.Start(start)
            ?? throw new InvalidOperationException("Node.js could not be started.");
        using var validationCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        validationCancellation.CancelAfter(TimeSpan.FromSeconds(15));
        using var cancellationRegistration = validationCancellation.Token.Register(() =>
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
            catch { }
        });
        string output;
        try
        {
            var stdout = process.StandardOutput.ReadToEndAsync(validationCancellation.Token);
            var stderr = process.StandardError.ReadToEndAsync(validationCancellation.Token);
            await process.WaitForExitAsync(validationCancellation.Token);
            output = (await stdout).Trim();
            _ = await stderr;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new InvalidOperationException("Node.js did not respond to its version check.");
        }
        if (process.ExitCode != 0 || !Version.TryParse(output.TrimStart('v'), out var version)
            || version < new Version(22, 13))
            throw new InvalidOperationException("OpenView requires Node.js 22.13 or newer.");
        return node;
    }

    internal static void SanitizeEnvironment(ProcessStartInfo start)
    {
        foreach (var key in start.Environment.Keys.ToArray())
            if (SensitiveEnvironmentName().IsMatch(key)) start.Environment.Remove(key);
        start.Environment.Remove("PHOTON_API_URL");
        start.Environment.Remove("FCC_USERNAME");
        start.Environment["CLOUDFLARE_INCLUDE_PROCESS_ENV"] = "false";
        start.Environment["WRANGLER_WRITE_LOGS"] = "false";
        start.Environment["WRANGLER_LOG"] = "error";
        start.Environment["NO_COLOR"] = "1";
    }

    private static void CreateStartMenuShortcut(string target)
    {
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
            "Programs", "OpenView");
        EnsureNoReparsePointsThrough(directory);
        Directory.CreateDirectory(directory);
        EnsureNoReparsePointsThrough(directory);
        var shortcutPath = Path.Combine(directory, "OpenView.lnk");
        EnsureNoReparsePointsThrough(shortcutPath);
        var shellType = Type.GetTypeFromProgID("WScript.Shell")
            ?? throw new InvalidOperationException("Windows shortcut support is unavailable.");
        object? shell = null;
        object? shortcut = null;
        try
        {
            shell = Activator.CreateInstance(shellType);
            dynamic dynamicShell = shell
                ?? throw new InvalidOperationException("Windows shortcut support could not start.");
            shortcut = dynamicShell.CreateShortcut(shortcutPath);
            dynamic dynamicShortcut = shortcut;
            dynamicShortcut.TargetPath = Path.Combine(target, InstalledExecutableName);
            dynamicShortcut.Arguments = "--launch";
            dynamicShortcut.WorkingDirectory = target;
            dynamicShortcut.IconLocation = Path.Combine(target, InstalledExecutableName) + ",0";
            dynamicShortcut.Description = $"OpenView {ReleaseConfig.Current.Version}";
            EnsureNoReparsePointsThrough(directory);
            EnsureNoReparsePointsThrough(shortcutPath);
            dynamicShortcut.Save();
            EnsureNoReparsePointsThrough(shortcutPath);
        }
        finally
        {
            if (shortcut is not null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (shell is not null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }

    private static void RegisterUninstaller(string target)
    {
        using var key = Registry.CurrentUser.CreateSubKey(UninstallKey);
        var executable = Path.Combine(target, InstalledExecutableName);
        key.SetValue("DisplayName", "OpenView");
        key.SetValue("DisplayVersion", ReleaseConfig.Current.Version);
        key.SetValue("Publisher", "jamezcody");
        key.SetValue("InstallLocation", target);
        key.SetValue("DisplayIcon", $"\"{executable}\"");
        key.SetValue("UninstallString", $"\"{executable}\" --uninstall");
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
    }

    internal static IReadOnlyList<string> RemoveShellAndUserDataBestEffort(string installation)
    {
        var warnings = new List<string>();
        // The validated installation has already been removed by the uninstaller.
        // Use its known path rather than rediscovering a now-missing marker.
        if (!string.IsNullOrWhiteSpace(installation))
        {
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            foreach (var browser in new[] { false, true })
            {
                try { ShellShortcuts.RemoveOwned(desktop, installation, browser); }
                catch (Exception error) { warnings.Add($"Desktop shortcut cleanup failed: {error.Message}"); }
            }
        }
        var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
            "Programs", "OpenView");
        try
        {
            if (Directory.Exists(startMenu))
            {
                EnsureNoReparseTree(startMenu);
                Directory.Delete(startMenu, true);
            }
        }
        catch (Exception error) { warnings.Add($"Start menu cleanup failed: {error.Message}"); }
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); }
        catch (Exception error) { warnings.Add($"Windows app registration cleanup failed: {error.Message}"); }
        try
        {
            if (Directory.Exists(UserDataDirectory))
            {
                EnsureNoReparseTree(UserDataDirectory);
                Directory.Delete(UserDataDirectory, true);
            }
        }
        catch (Exception error) { warnings.Add($"Settings cleanup failed: {error.Message}"); }
        return warnings;
    }

    internal static bool TrySafeDeleteDirectory(string path, out string error)
    {
        try
        {
            if (!Directory.Exists(path)) { error = ""; return true; }
            EnsureNoReparseTree(path);
            Directory.Delete(path, true);
            error = "";
            return true;
        }
        catch (Exception exception)
        {
            error = exception.Message;
            return false;
        }
    }

    internal static void EnsureNoReparseTree(string root)
    {
        EnsureNoReparsePointsThrough(root);
        if (!Directory.Exists(root)) return;
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count != 0)
        {
            var directory = pending.Pop();
            foreach (var path in Directory.EnumerateFileSystemEntries(directory))
            {
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidOperationException($"Refusing to traverse a reparse point: {path}");
                if (Directory.Exists(path)) pending.Push(path);
            }
        }
    }

    internal static string CombineUnderRoot(string root, string relative)
    {
        var canonicalRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var destination = Path.GetFullPath(Path.Combine(canonicalRoot, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!destination.StartsWith(canonicalRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("A path escapes its expected root.");
        return destination;
    }

    internal static void EnsureNoReparsePointsThrough(string path)
    {
        var full = Path.GetFullPath(path);
        var current = full;
        while (!string.IsNullOrEmpty(current))
        {
            if ((File.Exists(current) || Directory.Exists(current))
                && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException($"Reparse-point paths cannot be used: {current}");
            current = Directory.GetParent(current)?.FullName ?? string.Empty;
        }
    }

    internal static bool IsPathInside(string candidate, string directory)
    {
        var fullCandidate = Path.GetFullPath(candidate);
        var fullDirectory = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return fullCandidate.StartsWith(fullDirectory, StringComparison.OrdinalIgnoreCase);
    }

    private static bool PathsOverlap(string left, string right) =>
        PathsEqual(left, right) || IsPathInside(left, right) || IsPathInside(right, left);

    private static bool PathsEqual(string left, string right) =>
        string.Equals(Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar),
            Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);

    private static bool HashesEqual(string left, string right)
    {
        if (!ReleaseConfig.IsSha256(left) || !ReleaseConfig.IsSha256(right)) return false;
        return CryptographicOperations.FixedTimeEquals(Convert.FromHexString(left), Convert.FromHexString(right));
    }

    [GeneratedRegex("^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$", RegexOptions.IgnoreCase)]
    private static partial Regex ReservedDeviceNames();

    [GeneratedRegex("^PaxHeaders/openview-[0-9]{8}$", RegexOptions.CultureInvariant)]
    private static partial Regex PaxHeaderName();

    [GeneratedRegex("(?:^|_)(?:API_?KEY|API_?TOKEN|AUTH|PASSWORD|SECRET|TOKEN)(?:$|_)", RegexOptions.IgnoreCase)]
    private static partial Regex SensitiveEnvironmentName();
}
