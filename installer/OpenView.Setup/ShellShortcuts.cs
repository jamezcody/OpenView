using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace OpenView.Setup;

// Browser links open a loopback URL directly, without invoking our unsigned EXE.
// Only installer-owned links are migrated, refreshed, or removed.
internal static class ShellShortcuts
{
    internal const string LegacyBrowserFileName = "OpenView Browser.lnk";
    internal static string FileName(bool browser) => browser ? "OpenView Browser.url" : "OpenView.lnk";
    internal static string Arguments(bool browser) => browser ? "--browser" : "--launch";

    internal static void Create(string desktop, string installation, bool browser, int port = AppSettings.DefaultPort)
    {
        if (string.IsNullOrWhiteSpace(desktop) || !Directory.Exists(desktop))
            throw new InvalidOperationException("The Windows desktop directory is unavailable.");
        var path = Path.Combine(desktop, FileName(browser));
        InstallerEngine.EnsureNoReparsePointsThrough(path);
        if (browser)
        {
            CreateBrowser(path, installation, port);
            RemoveLegacyBrowser(desktop, installation);
            return;
        }
        var executable = Path.Combine(Path.GetFullPath(installation), InstallerEngine.InstalledExecutableName);
        WithShortcut(path, shortcut =>
        {
            if (File.Exists(path) && !Matches(shortcut, executable, browser))
                throw new InvalidOperationException($"{FileName(browser)} already exists and belongs to another target; it was left unchanged.");
            shortcut.TargetPath = executable;
            shortcut.Arguments = Arguments(browser);
            shortcut.WorkingDirectory = installation;
            shortcut.IconLocation = executable + ",0";
            shortcut.Description = browser ? "Open OpenView in your default browser" : "Start the OpenView local server";
            InstallerEngine.EnsureNoReparsePointsThrough(path);
            shortcut.Save();
        });
    }

    internal static void RemoveOwned(string desktop, string installation, bool browser)
    {
        if (string.IsNullOrWhiteSpace(desktop)) return;
        var path = Path.Combine(desktop, FileName(browser));
        InstallerEngine.EnsureNoReparsePointsThrough(path);
        if (browser)
        {
            if (MatchesBrowser(path, installation)) File.Delete(path);
            RemoveLegacyBrowser(desktop, installation);
            return;
        }
        if (!File.Exists(path)) return;
        var executable = Path.Combine(Path.GetFullPath(installation), InstallerEngine.InstalledExecutableName);
        var owned = false;
        WithShortcut(path, shortcut => owned = Matches(shortcut, executable, browser));
        if (owned)
        {
            InstallerEngine.EnsureNoReparsePointsThrough(path);
            File.Delete(path);
        }
    }

    private static bool Matches(dynamic shortcut, string executable, bool browser) =>
        string.Equals((string)shortcut.TargetPath, executable, StringComparison.OrdinalIgnoreCase)
        && (string)shortcut.Arguments == Arguments(browser);

    internal static string BrowserContent(string installation, int port)
    {
        AppSettings.ValidatePort(port);
        var root = Path.GetFullPath(installation);
        var icon = Path.Combine(root, "dist", "client", "OpenView.ico");
        var owner = Convert.ToBase64String(Encoding.UTF8.GetBytes(root));
        return $"[InternetShortcut]\r\nURL={LauncherForm.GetLocalUrl(port)}\r\nIconFile={icon}\r\nIconIndex=0\r\nIDList=\r\n\r\n[OpenView]\r\nInstallation={owner}\r\n[{{000214A0-0000-0000-C000-000000000046}}]\r\nProp3=19,2\r\n";
    }

    private static bool MatchesBrowser(string path, string installation)
    {
        InstallerEngine.EnsureNoReparsePointsThrough(path);
        var info = new FileInfo(path);
        if (!info.Exists || info.Length is < 1 or > 65536) return false;
        var content = File.ReadAllText(path);
        var match = Regex.Match(content, @"\A\[InternetShortcut\]\r\nURL=http://127\.0\.0\.1:([0-9]{1,5})/\r\n", RegexOptions.CultureInvariant);
        if (!match.Success) return false;
        try { return content == BrowserContent(installation, AppSettings.ParsePort(match.Groups[1].Value)); }
        catch (InvalidOperationException) { return false; }
    }

    private static void CreateBrowser(string path, string installation, int port)
    {
        var content = BrowserContent(installation, port);
        void CheckDestination()
        {
            InstallerEngine.EnsureNoReparsePointsThrough(path);
            if (File.Exists(path) && !MatchesBrowser(path, installation))
                throw new InvalidOperationException("OpenView Browser.url already exists and is not an unchanged OpenView-owned link; it was left unchanged.");
        }
        CheckDestination();
        var temporary = Path.Combine(Path.GetDirectoryName(path)!, $".OpenView-{Guid.NewGuid():N}.tmp");
        try
        {
            // UTF-16 with BOM is supported by Windows Internet Shortcut INI files,
            // including icon paths under non-ASCII Windows profile directories.
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (var writer = new StreamWriter(stream, Encoding.Unicode)) writer.Write(content);
            CheckDestination();
            File.Move(temporary, path, true);
            // Save through Windows as well: its Internet Shortcut object may
            // otherwise retain a previously read URL after an atomic replacement.
            WithShortcut(path, shortcut =>
            {
                shortcut.TargetPath = LauncherForm.GetLocalUrl(port);
                shortcut.Save();
            });
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static bool OwnsLegacyBrowser(string desktop, string installation)
    {
        var path = Path.Combine(desktop, LegacyBrowserFileName);
        InstallerEngine.EnsureNoReparsePointsThrough(path);
        if (!File.Exists(path)) return false;
        var owned = false;
        WithShortcut(path, shortcut => owned = Matches(shortcut,
            Path.Combine(Path.GetFullPath(installation), InstallerEngine.InstalledExecutableName), browser: true));
        return owned;
    }

    private static void RemoveLegacyBrowser(string desktop, string installation)
    {
        if (OwnsLegacyBrowser(desktop, installation)) File.Delete(Path.Combine(desktop, LegacyBrowserFileName));
    }

    internal static void RefreshBrowserIfOwned(string desktop, string installation, int port)
    {
        if (string.IsNullOrWhiteSpace(desktop) || !Directory.Exists(desktop)) return;
        if (MatchesBrowser(Path.Combine(desktop, FileName(true)), installation) || OwnsLegacyBrowser(desktop, installation))
            Create(desktop, installation, browser: true, port: port);
    }

    internal static void WithShortcut(string path, Action<dynamic> action)
    {
        var type = Type.GetTypeFromProgID("WScript.Shell")
            ?? throw new InvalidOperationException("Windows shortcut support is unavailable.");
        object? shell = null;
        object? shortcut = null;
        try
        {
            shell = Activator.CreateInstance(type)
                ?? throw new InvalidOperationException("Windows shortcut support could not start.");
            shortcut = ((dynamic)shell).CreateShortcut(path);
            action(shortcut);
        }
        finally
        {
            if (shortcut is not null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (shell is not null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }

}
