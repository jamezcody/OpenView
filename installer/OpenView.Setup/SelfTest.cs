using System.Net;
using System.Net.Sockets;
using System.Text;

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
            foreach (var browser in new[] { false, true })
            {
                ShellShortcuts.Create(temporary, installation, browser);
                ShellShortcuts.Create(temporary, installation, browser);
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
                    if (!string.Equals((string)shortcut.TargetPath, executable, StringComparison.OrdinalIgnoreCase)
                        || (string)shortcut.Arguments != ShellShortcuts.Arguments(browser)
                        || !((string)shortcut.IconLocation).StartsWith(executable, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("A desktop shortcut has an incorrect target, argument, or icon.");
                });
                ShellShortcuts.RemoveOwned(temporary, Path.Combine(temporary, "Another installation"), browser);
                if (!File.Exists(path)) throw new InvalidOperationException("An unrelated shortcut was removed.");
                ExpectFailure(() => ShellShortcuts.Create(temporary, Path.Combine(temporary, "Another installation"), browser));
                ShellShortcuts.RemoveOwned(temporary, installation, browser);
                if (File.Exists(path)) throw new InvalidOperationException("An owned shortcut was not removed.");
            }
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
        try
        {
            var result = await InstallerEngine.InstallAsync(
                new InstallOptions(target, null, AcceptanceTest: true),
                new Progress<string>(message => Console.Error.WriteLine(message)),
                CancellationToken.None);
            if (result.Warnings.Count != 0)
                throw new InvalidOperationException("The acceptance install produced unexpected warnings.");
            InstallerEngine.ValidateInstalledLayout(result.InstallDirectory);
            return 0;
        }
        finally
        {
            if (Directory.Exists(target)
                && !InstallerEngine.TrySafeDeleteDirectory(target, out var error))
                throw new IOException($"The acceptance installation could not be cleaned up: {error}");
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
