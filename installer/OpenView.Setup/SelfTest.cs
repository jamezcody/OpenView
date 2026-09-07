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
