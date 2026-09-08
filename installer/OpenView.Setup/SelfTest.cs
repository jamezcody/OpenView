using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenView.Setup;

internal static class SelfTest
{
    public static int Run(string[] args)
    {
        var manifest = ReleaseConfig.Current;
        ReleaseConfig.Validate(manifest);
        if (!ReleaseConfig.IsSha256(ReleaseConfig.ManifestSha256))
            throw new InvalidOperationException("The embedded manifest checksum is invalid.");

        var sidecarIndex = Array.FindIndex(args,
            value => value.Equals("--sidecar-dir", StringComparison.OrdinalIgnoreCase));
        if (sidecarIndex >= 0)
        {
            if (sidecarIndex + 1 >= args.Length)
                throw new InvalidOperationException("--sidecar-dir requires a directory.");
            var directory = Path.GetFullPath(args[sidecarIndex + 1]);
            var publishedManifest = Path.Combine(directory, "release-manifest.json");
            var manifestInfo = new FileInfo(publishedManifest);
            if (!manifestInfo.Exists || manifestInfo.Length is < 1 or > 1024 * 1024)
                throw new InvalidOperationException("The published release manifest is missing or invalid.");
            using (var input = File.OpenRead(publishedManifest))
            {
                var actualManifestHash = Convert.ToHexString(
                    System.Security.Cryptography.SHA256.HashData(input)).ToLowerInvariant();
                if (!string.Equals(actualManifestHash, ReleaseConfig.ManifestSha256, StringComparison.Ordinal))
                    throw new InvalidOperationException("The published and embedded release manifests differ.");
            }
            VerifyIfPresent(directory, manifest.RuntimeArchive, ArchiveKind.Runtime);
            VerifyIfPresent(directory, manifest.DataArchive, ArchiveKind.Data);
        }

        _ = InstallerEngine.ValidatePhotonUrl("https://photon.komoot.io/api");
        ExpectFailure(() => InstallerEngine.ValidatePhotonUrl("http://photon.example/api"));
        ExpectFailure(() => InstallerEngine.ValidatePhotonUrl("https://user@example.invalid/api"));
        ExpectFailure(() => InstallerEngine.ValidatePhotonUrl("https://example.invalid/api?q=nope"));
        ExpectFailure(() => InstallerEngine.ValidatePhotonUrl("https://example.invalid/api#fragment"));

        VerifySettingsAndPorts();
        VerifyPortAvailability();
        VerifyBrandingAndShortcuts();
        VerifyCredentialBoundaries();
        VerifyPreparedInstallationLayout();
        VerifyLargeArchiveLimits();
        VerifyAcceptanceTargetSafety();
        VerifyArchiveCopyBoundaries();

        if (InstallerEngine.NormalizeArchivePath("./dist/client/favicon.svg", false) != "dist/client/favicon.svg")
            throw new InvalidOperationException("Archive-path normalization failed.");
        foreach (var unsafePath in new[]
        {
            "../escape", "/rooted", "././double", "dist\\backslash", "dist/CON/file", "C:/rooted",
            "dist/trailing."
        }) ExpectFailure(() => InstallerEngine.NormalizeArchivePath(unsafePath, false));
        ExpectFailure(() => InstallerEngine.ValidateInstallDirectory(Path.GetPathRoot(Environment.SystemDirectory)!));
        ExpectFailure(() => InstallerEngine.ValidateInstallDirectory(InstallerEngine.UserDataDirectory));
        using (var job = new KillOnCloseJob()) { }
        return 0;
    }

    private static void VerifyCredentialBoundaries()
    {
        // Validation only: never read, replace, or remove the user's saved vault entries.
        CredentialManager.ValidateAisStreamReplacement("placeholder");
        foreach (var invalid in new[] { "", " ", new string('x', 1281) })
            ExpectFailure(() => CredentialManager.ValidateAisStreamReplacement(invalid));
        var start = new System.Diagnostics.ProcessStartInfo();
        foreach (var name in new[] { "AISSTREAM_API_KEY", "FCC_API_TOKEN", "OPENCELLID_API_TOKEN" })
            start.Environment[name] = "placeholder";
        InstallerEngine.SanitizeEnvironment(start);
        if (new[] { "AISSTREAM_API_KEY", "FCC_API_TOKEN", "OPENCELLID_API_TOKEN" }
            .Any(start.Environment.ContainsKey))
            throw new InvalidOperationException("A credential leaked into the child runtime environment.");
    }

    private static void VerifyBrandingAndShortcuts()
    {
        using var icon = Branding.CreateIcon();
        if (icon.Width != 32 || icon.Height != 32 || Branding.Logo.Width < 256)
            throw new InvalidOperationException("The OpenView icon/logo resources are invalid.");
        var options = new InstallOptions("unused", null);
        if (options.DesktopLauncher || options.DesktopBrowser)
            throw new InvalidOperationException("Desktop shortcuts must be opt-in.");

        var temporary = Directory.CreateTempSubdirectory("OpenView-Shortcut-Test-").FullName;
        try
        {
            var installation = Path.Combine(temporary, "Installation with spaces ü");
            Directory.CreateDirectory(installation);
            var executable = Path.Combine(installation, InstallerEngine.InstalledExecutableName);
            File.WriteAllText(executable, "shortcut target fixture");
            File.WriteAllText(Path.Combine(installation, InstallerEngine.InstalledLauncherName), "// launcher fixture");
            var node = Path.Combine(temporary, "node.exe");
            File.WriteAllText(node, "Node shortcut fixture; never executed");
            var iconPath = Path.Combine(installation, "dist", "client", "OpenView.ico");
            foreach (var browser in new[] { false, true })
            {
                ShellShortcuts.Create(temporary, installation, browser, nodeExecutable: node);
                var beforeRefresh = File.ReadAllBytes(Path.Combine(temporary, ShellShortcuts.FileName(browser)));
                ShellShortcuts.Create(temporary, installation, browser, nodeExecutable: node);
                var path = Path.Combine(temporary, ShellShortcuts.FileName(browser));
                ShellShortcuts.WithShortcut(path, shortcut =>
                {
                    if (browser)
                    {
                        if ((string)shortcut.TargetPath != LauncherForm.GetLocalUrl(AppSettings.DefaultPort)
                            || File.ReadAllText(path) != ShellShortcuts.BrowserContent(installation, AppSettings.DefaultPort))
                            throw new InvalidOperationException("The browser shortcut does not open the direct local URL.");
                        return;
                    }
                    if (!string.Equals((string)shortcut.TargetPath, node, StringComparison.OrdinalIgnoreCase)
                        || (string)shortcut.Arguments != ShellShortcuts.LocalLauncherArguments(installation)
                        || !((string)shortcut.IconLocation).StartsWith(iconPath, StringComparison.OrdinalIgnoreCase)
                        || !beforeRefresh.SequenceEqual(File.ReadAllBytes(path)))
                        throw new InvalidOperationException("A desktop shortcut has an incorrect target, argument, or icon.");
                });
                ShellShortcuts.RemoveOwned(temporary, Path.Combine(temporary, "Another installation"), browser);
                if (!File.Exists(path)) throw new InvalidOperationException("An unrelated shortcut was removed.");
                ExpectFailure(() => ShellShortcuts.Create(temporary, Path.Combine(temporary, "Another installation"), browser));
                ShellShortcuts.RemoveOwned(temporary, installation, browser);
                if (File.Exists(path)) throw new InvalidOperationException("An owned shortcut was not removed.");
            }
            var launcherPath = Path.Combine(temporary, ShellShortcuts.FileName(false));
            ShellShortcuts.WithShortcut(launcherPath, shortcut =>
            {
                shortcut.TargetPath = executable;
                shortcut.Arguments = "--launch";
                shortcut.Save();
            });
            ShellShortcuts.Create(temporary, installation, browser: false, nodeExecutable: node);
            ShellShortcuts.WithShortcut(launcherPath, shortcut =>
            {
                if (!string.Equals((string)shortcut.TargetPath, node, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("The old executable launcher was not migrated to Node.");
                shortcut.Arguments = ShellShortcuts.LocalLauncherArguments(installation) + " --no-browser";
                shortcut.WindowStyle = 1;
                shortcut.Save();
            });
            var customizedLink = File.ReadAllBytes(launcherPath);
            ShellShortcuts.Create(temporary, installation, browser: false, nodeExecutable: node);
            if (!customizedLink.SequenceEqual(File.ReadAllBytes(launcherPath)))
                throw new InvalidOperationException("The existing Node launcher link was modified.");
            ShellShortcuts.RemoveOwned(temporary, installation, browser: false);
            if (File.Exists(launcherPath)) throw new InvalidOperationException("The owned Node launcher link was not removed.");
            ShellShortcuts.WithShortcut(launcherPath, shortcut =>
            {
                shortcut.TargetPath = node;
                shortcut.Arguments = "\"" + Path.Combine(installation, "another-script.mjs") + "\"";
                shortcut.Save();
            });
            var unrelatedNodeLink = File.ReadAllBytes(launcherPath);
            ExpectFailure(() => ShellShortcuts.Create(temporary, installation, browser: false, nodeExecutable: node));
            ShellShortcuts.RemoveOwned(temporary, installation, browser: false);
            if (!unrelatedNodeLink.SequenceEqual(File.ReadAllBytes(launcherPath)))
                throw new InvalidOperationException("An unrelated Node shortcut was modified or removed.");
            var browserPath = Path.Combine(temporary, ShellShortcuts.FileName(true));
            ShellShortcuts.RefreshBrowserIfOwned(temporary, installation, 8080);
            if (File.Exists(browserPath)) throw new InvalidOperationException("An unselected browser shortcut was created.");
            var legacyPath = Path.Combine(temporary, ShellShortcuts.LegacyBrowserFileName);
            ShellShortcuts.WithShortcut(legacyPath, shortcut =>
            {
                shortcut.TargetPath = executable;
                shortcut.Arguments = "--browser";
                shortcut.Save();
            });
            ShellShortcuts.RefreshBrowserIfOwned(temporary, installation, 8080);
            if (File.Exists(legacyPath) || File.ReadAllText(browserPath) != ShellShortcuts.BrowserContent(installation, 8080))
                throw new InvalidOperationException("The legacy browser shortcut was not migrated.");
            ShellShortcuts.RefreshBrowserIfOwned(temporary, installation, 9999);
            ShellShortcuts.WithShortcut(browserPath, shortcut =>
            {
                if ((string)shortcut.TargetPath != "http://127.0.0.1:9999/")
                    throw new InvalidOperationException("The browser shortcut port was not updated. Windows target: " + (string)shortcut.TargetPath
                        + "; file matches new port: " + (File.ReadAllText(browserPath) == ShellShortcuts.BrowserContent(installation, 9999)));
            });
            File.WriteAllText(browserPath, "[InternetShortcut]\r\nURL=https://example.com/\r\n");
            ShellShortcuts.RefreshBrowserIfOwned(temporary, installation, 8080);
            ShellShortcuts.RemoveOwned(temporary, installation, true);
            if (!File.Exists(browserPath) || !File.ReadAllText(browserPath).Contains("https://example.com/"))
                throw new InvalidOperationException("A modified browser shortcut was overwritten or deleted.");
            ExpectFailure(() => ShellShortcuts.Create(temporary, installation, true));
        }
        finally
        {
            if (!InstallerEngine.TrySafeDeleteDirectory(temporary, out var error))
                throw new IOException($"Shortcut test cleanup failed: {error}");
        }
    }

    private static void VerifySettingsAndPorts()
    {
        const string photonUrl = "https://photon.example.test/api";
        var defaults = AppSettings.Parse(Encoding.UTF8.GetBytes("{}"));
        if (defaults != AppSettings.Default
            || AppSettings.Parse(Encoding.UTF8.GetBytes(defaults.Serialize())) != defaults)
            throw new InvalidOperationException("Default OpenView settings did not round-trip.");

        var legacy = AppSettings.Parse(Encoding.UTF8.GetBytes(
            $$"""{"schemaVersion":1,"photonApiUrl":"{{photonUrl}}"}"""));
        if (legacy.PhotonApiUrl != photonUrl || legacy.Port != AppSettings.DefaultPort)
            throw new InvalidOperationException("Legacy settings did not retain the default local port.");

        var expected = new AppSettings(photonUrl, 49152);
        var companionStart = InstallerForm.CreateLauncherStartInfo(AppContext.BaseDirectory, "node.exe");
        if (companionStart.FileName != "node.exe" || companionStart.ArgumentList.Count != 1
            || companionStart.ArgumentList[0] != Path.Combine(AppContext.BaseDirectory, InstallerEngine.InstalledLauncherName)
            || companionStart.WorkingDirectory != AppContext.BaseDirectory || !companionStart.UseShellExecute)
            throw new InvalidOperationException("The setup launch action does not use the local Node companion.");
        var start = LauncherForm.CreateWorkerStartInfo(AppContext.BaseDirectory, "node.exe", expected);
        if (!start.ArgumentList[0].EndsWith(Path.Combine("dist", "local", "server.mjs"), StringComparison.Ordinal)
            || !start.ArgumentList.Contains("49152") || !start.ArgumentList.Contains("--photon-url")
            || !start.ArgumentList.Contains(photonUrl) || start.UseShellExecute || !start.CreateNoWindow)
            throw new InvalidOperationException("The local data server launch configuration is invalid.");
        var roundTrip = AppSettings.Parse(Encoding.UTF8.GetBytes(expected.Serialize()));
        if (roundTrip != expected)
            throw new InvalidOperationException("OpenView settings did not round-trip.");

        foreach (var port in new[] { 2, 80, 8080, AppSettings.DefaultPort, 65535 })
        {
            AppSettings.ValidatePort(port);
            if (AppSettings.ParsePort(port.ToString()) != port)
                throw new InvalidOperationException("A valid local port did not parse.");
            if (LauncherForm.GetLocalUrl(port) != $"http://127.0.0.1:{port}/")
                throw new InvalidOperationException("The local OpenView URL is invalid.");
        }

        foreach (var port in new[] { 0, -1, 1, 22, 6000, 6667, 10080, 65536, int.MinValue, int.MaxValue })
            ExpectFailure(() => AppSettings.ValidatePort(port));
        foreach (var port in new string?[] { null, "", " ", "+1", "-1", "1.0", "1e3", "65536", "abc" })
            ExpectFailure(() => AppSettings.ParsePort(port));
        foreach (var json in new[]
        {
            """{"schemaVersion":1,"photonApiUrl":null,"port":null}""",
            """{"schemaVersion":1,"photonApiUrl":null,"port":"8787"}""",
            """{"schemaVersion":1,"photonApiUrl":null,"port":8787.5}""",
            """{"schemaVersion":1,"photonApiUrl":null,"port":0}""",
            """{"schemaVersion":1,"photonApiUrl":null,"port":65536}""",
        }) ExpectFailure(() => AppSettings.Parse(Encoding.UTF8.GetBytes(json)));
    }

    private static void VerifyPreparedInstallationLayout()
    {
        var temporary = Directory.CreateTempSubdirectory("OpenView-Layout-Test-").FullName;
        try
        {
            var manifest = ReleaseConfig.Current;
            var runtime = Path.Combine(temporary, "runtime");
            var data = Path.Combine(temporary, "data");
            void Write(string root, string relative, string content)
            {
                var path = InstallerEngine.CombineUnderRoot(root, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, content);
            }
            foreach (var required in InstallerEngine.RequiredRuntimeFiles) Write(runtime, required, "runtime fixture");
            using (var listener = new TcpListener(IPAddress.Loopback, 0))
            {
                listener.Server.ExclusiveAddressUse = true;
                listener.Start();
                var occupiedPort = ((IPEndPoint)listener.LocalEndpoint).Port;
                ExpectFailure(() => InstallerEngine.EnsureNodeLauncherStopped(runtime, occupiedPort));
                if (!listener.Server.IsBound)
                    throw new InvalidOperationException("The running-server upgrade check stopped an unrelated listener.");
                listener.Stop();
                InstallerEngine.EnsureNodeLauncherStopped(runtime, occupiedPort);
            }
            Write(runtime, InstallerEngine.InstalledExecutableName, "ownership fixture; never executed");
            Write(runtime, InstallerEngine.MarkerName, JsonSerializer.Serialize(new InstallMarker
            {
                SchemaVersion = 1, ProductId = InstallerEngine.ProductId, Version = "0.2.0",
                ManifestSha256 = new string('0', 64), RuntimeArchiveSha256 = new string('0', 64),
                DataArchiveSha256 = new string('0', 64),
            }));
            foreach (var directory in manifest.DataDirectories) Write(data, $"public/{directory}/latest.json", "{\"schemaVersion\":1}");
            const string radioVersion = "radio-0123456789abcdef0123";
            const string searchVersion = "search-0123456789abcdef0123";
            Write(data, "public/radio/latest.json", $$"""{"schemaVersion":1,"version":"{{radioVersion}}"}""");
            Write(data, $"public/radio/versions/{radioVersion}/manifest.json", "{\"schemaVersion\":1}");
            string SearchCatalog(string expectedRadio = radioVersion, long bytes = 512) => JsonSerializer.Serialize(new
            {
                schemaVersion = 2, version = searchVersion, radioVersion = expectedRadio,
                files = new[] { new { kind = "radio", file = "radio.sqlite", encoding = "radio-sqlite-v1", bytes, sha256 = new string('0', 64) } },
            });
            Write(data, "public/search/latest.json", SearchCatalog());
            Write(data, $"public/search/{searchVersion}/radio.sqlite", "");
            var databaseBytes = new byte[512];
            "SQLite format 3\0"u8.CopyTo(databaseBytes);
            File.WriteAllBytes(Path.Combine(data, "public", "search", searchVersion, "radio.sqlite"), databaseBytes);

            InstallerEngine.MergeDataIntoRuntime(data, runtime, manifest);
            InstallerEngine.ValidateDataLayout(runtime, manifest, allowLegacy: false);
            InstallerEngine.ValidateOwnedInstallationStructure(runtime);
            foreach (var directory in manifest.DataDirectories)
            {
                var expected = $"dist/{(directory is "radio" or "search" ? "prepared" : "client")}/{directory}/latest.json";
                if (!File.Exists(InstallerEngine.CombineUnderRoot(runtime, expected)))
                    throw new InvalidOperationException($"The {directory} dataset was activated in the wrong directory.");
            }
            if (Directory.EnumerateFileSystemEntries(Path.Combine(data, "public")).Any())
                throw new InvalidOperationException("Dataset activation left files behind.");

            // Both original v0.2.0 and the locally migrated v0.2.0 remain owned.
            foreach (var directory in new[] { "radio", "search" })
                Directory.Move(Path.Combine(runtime, "dist", "prepared", directory), Path.Combine(runtime, "dist", "client", directory));
            InstallerEngine.ValidateOwnedInstallationStructure(runtime);
            ExpectFailure(() => InstallerEngine.ValidateDataLayout(runtime, manifest, allowLegacy: false));
            foreach (var directory in new[] { "radio", "search" })
                Directory.Move(Path.Combine(runtime, "dist", "client", directory), Path.Combine(runtime, "dist", "prepared", directory));

            var searchPointer = "dist/prepared/search/latest.json";
            Write(runtime, searchPointer, SearchCatalog("radio-ffffffffffffffffffff"));
            ExpectFailure(() => InstallerEngine.ValidateDataLayout(runtime, manifest, allowLegacy: false));
            Write(runtime, searchPointer, SearchCatalog(bytes: 6101401600L));
            ExpectFailure(() => InstallerEngine.ValidateDataLayout(runtime, manifest, allowLegacy: false));
            Write(runtime, searchPointer, SearchCatalog());
            var database = Path.Combine(runtime, "dist", "prepared", "search", searchVersion, "radio.sqlite");
            File.WriteAllBytes(database, new byte[512]);
            ExpectFailure(() => InstallerEngine.ValidateDataLayout(runtime, manifest, allowLegacy: false));
            File.WriteAllBytes(database, databaseBytes);
            File.Move(database, database + ".held");
            ExpectFailure(() => InstallerEngine.ValidateDataLayout(runtime, manifest, allowLegacy: false));
            File.Move(database + ".held", database);
            InstallerEngine.ValidateDataLayout(runtime, manifest, allowLegacy: false);
            foreach (var relative in new[] { InstallerEngine.InstalledLauncherName, "dist/local/prepared-data.mjs", "dist/local/radio-search.mjs", "dist/local/radio-search-worker.mjs" })
            {
                var path = InstallerEngine.CombineUnderRoot(runtime, relative);
                File.Move(path, path + ".held");
                ExpectFailure(() => InstallerEngine.ValidateRequiredFiles(runtime, InstallerEngine.RequiredRuntimeFiles));
                File.Move(path + ".held", path);
            }

            var previous = Path.Combine(temporary, "previous");
            const string customizedLauncher = "// existing working user launcher\r\n";
            InstallerEngine.PreserveExistingLauncher(previous, runtime);
            Write(previous, InstallerEngine.InstalledLauncherName, customizedLauncher);
            InstallerEngine.PreserveExistingLauncher(previous, runtime);
            if (File.ReadAllText(Path.Combine(runtime, InstallerEngine.InstalledLauncherName)) != customizedLauncher
                || File.ReadAllText(Path.Combine(previous, InstallerEngine.InstalledLauncherName)) != customizedLauncher)
                throw new InvalidOperationException("An upgrade did not preserve the existing local launcher.");

            InstallerEngine.ValidateArchiveScope(InstallerEngine.InstalledLauncherName, true, ArchiveKind.Runtime, manifest);
            foreach (var unexpected in new[] { "other.mjs", "launch-local.mjs/child", "dist/client/radio/latest.json", "dist/prepared/radio/latest.json", "dist/prepared/search/radio.sqlite" })
                ExpectFailure(() => InstallerEngine.ValidateArchiveScope(unexpected, true, ArchiveKind.Runtime, manifest));
            ExpectFailure(() => InstallerEngine.ValidateArchiveScope(InstallerEngine.InstalledLauncherName, false, ArchiveKind.Runtime, manifest));
        }
        finally
        {
            if (!InstallerEngine.TrySafeDeleteDirectory(temporary, out var error))
                throw new IOException($"Prepared-layout test cleanup failed: {error}");
        }
    }

    private static void VerifyLargeArchiveLimits()
    {
        var document = JsonSerializer.SerializeToNode(ReleaseConfig.Current)!;
        var archive = document["DataArchive"]!;
        archive["CompressedBytes"] = 1800000000L;
        archive["MaximumCompressedBytes"] = 2L * 1024 * 1024 * 1024;
        archive["FileCount"] = 450000L;
        archive["MaximumFileCount"] = 500000L;
        archive["UncompressedBytes"] = 15L * 1024 * 1024 * 1024;
        archive["MaximumUncompressedBytes"] = 20L * 1024 * 1024 * 1024;
        ReleaseConfig.Validate(document.Deserialize<ReleaseManifest>()!);
        foreach (var (value, maximum) in new[]
        {
            ("CompressedBytes", "MaximumCompressedBytes"), ("FileCount", "MaximumFileCount"),
            ("UncompressedBytes", "MaximumUncompressedBytes"),
        })
        {
            var valid = archive[value]!.GetValue<long>();
            archive[value] = archive[maximum]!.GetValue<long>() + 1;
            ExpectFailure(() => ReleaseConfig.Validate(document.Deserialize<ReleaseManifest>()!));
            archive[value] = valid;
        }
        const long databaseBytes = 6101401600L;
        var field = Encoding.ASCII.GetBytes(Convert.ToString(databaseBytes, 8).PadLeft(11, '0') + '\0');
        if (InstallerEngine.ParseTarOctal(field, "size", "large SQLite fixture") != databaseBytes)
            throw new InvalidOperationException("The TAR reader truncated a SQLite file larger than 2 GiB.");
    }

    private static void VerifyAcceptanceTargetSafety()
    {
        // A rejected acceptance request must never remove an existing directory.
        foreach (var prefix in new[] { "OpenView-Acceptance-", "OpenView-Unrelated-Test-" })
        {
            var existing = Directory.CreateTempSubdirectory(prefix).FullName;
            try
            {
                var sentinel = Path.Combine(existing, "keep.txt");
                File.WriteAllText(sentinel, "existing directory must survive");
                ExpectFailure(() => RunAcceptanceAsync(existing).GetAwaiter().GetResult());
                if (!File.Exists(sentinel) || File.ReadAllText(sentinel) != "existing directory must survive")
                    throw new InvalidOperationException("A rejected acceptance request removed existing files.");
            }
            finally
            {
                if (!InstallerEngine.TrySafeDeleteDirectory(existing, out var error))
                    throw new IOException($"Acceptance safety test cleanup failed: {error}");
            }
        }
        var fresh = Path.Combine(Path.GetTempPath(), $"OpenView-Acceptance-{Guid.NewGuid():N}");
        InstallerEngine.ValidateAcceptanceTarget(fresh);
        if (Directory.Exists(fresh))
            throw new InvalidOperationException("Acceptance path validation created a directory.");
    }

    private static void VerifyArchiveCopyBoundaries()
    {
        var buffer = new byte[4096];
        // Reuse the same buffer across differently sized entries so neither
        // stale tail bytes nor a preceding entry's hash can leak into the next.
        foreach (var length in new[] { 9001, 17, 0, 8192 })
        {
            var payload = Enumerable.Range(0, length).Select(index => (byte)(index % 251)).ToArray();
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(payload));
            using var input = new MemoryStream([..payload, 123]);
            using var output = new MemoryStream();
            InstallerEngine.CopyExactly(input, output, payload.Length, CancellationToken.None, hash, buffer);
            if (!output.ToArray().SequenceEqual(payload) || input.ReadByte() != 123)
                throw new InvalidOperationException("The archive copy crossed a declared entry boundary.");
        }
        ExpectFailure(() => InstallerEngine.CopyExactly(new MemoryStream([1, 2]), Stream.Null, 3,
            CancellationToken.None, null, buffer));
        ExpectFailure(() => InstallerEngine.CopyExactly(new MemoryStream([1, 2]), Stream.Null, 2,
            CancellationToken.None, new string('0', 64), buffer));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        try
        {
            InstallerEngine.CopyExactly(new MemoryStream([1]), Stream.Null, 1, cancellation.Token, null, buffer);
        }
        catch (OperationCanceledException) { return; }
        throw new InvalidOperationException("Archive extraction ignored cancellation.");
    }

    private static void VerifyPortAvailability()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Server.ExclusiveAddressUse = true;
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        ExpectFailure(() => LauncherForm.RefuseOccupiedPort(port));
        listener.Stop();
        LauncherForm.RefuseOccupiedPort(port);
    }

    public static async Task<int> RunAcceptanceAsync(string target)
    {
        target = InstallerEngine.ValidateInstallDirectory(target);
        // Reject existing/foreign targets before entering any cleanup scope.
        InstallerEngine.ValidateAcceptanceTarget(target);
        var installed = false;
        try
        {
            var result = await InstallerEngine.InstallAsync(
                new InstallOptions(target, null, AcceptanceTest: true),
                new Progress<string>(message => Console.Error.WriteLine(message)),
                CancellationToken.None);
            installed = true;
            if (result.Warnings.Count != 0)
                throw new InvalidOperationException("The acceptance install produced unexpected warnings.");
            InstallerEngine.ValidateInstalledLayout(result.InstallDirectory);
            return 0;
        }
        finally
        {
            // InstallAsync owns rollback on failure. Only remove a target after
            // that call completed successfully and its current layout is owned.
            if (installed && Directory.Exists(target))
            {
                InstallerEngine.ValidateInstalledLayout(target);
                if (!InstallerEngine.TrySafeDeleteDirectory(target, out var error))
                    throw new IOException($"The acceptance installation could not be cleaned up: {error}");
            }
        }
    }

    private static void VerifyIfPresent(string directory, ArchiveDescriptor descriptor, ArchiveKind kind)
    {
        var path = Path.Combine(directory, descriptor.Name);
        if (File.Exists(path)) InstallerEngine.VerifyArchiveFile(path, descriptor, kind);
    }

    private static void ExpectFailure(Action action)
    {
        try { action(); }
        catch (InvalidOperationException) { return; }
        throw new InvalidOperationException("A self-test safety rejection did not occur.");
    }
}
