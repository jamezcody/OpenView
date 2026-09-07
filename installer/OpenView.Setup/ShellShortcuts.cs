using System.Runtime.InteropServices;

namespace OpenView.Setup;

// Browser shortcuts resolve saved settings at click time, so changing the port
// does not leave a stale desktop URL. No executable is copied to the desktop.
internal static class ShellShortcuts
{
    internal static string FileName(bool browser) => browser ? "OpenView Browser.lnk" : "OpenView.lnk";
    internal static string Arguments(bool browser) => browser ? "--browser" : "--launch";

    internal static void Create(string desktop, string installation, bool browser)
    {
        if (string.IsNullOrWhiteSpace(desktop) || !Directory.Exists(desktop))
            throw new InvalidOperationException("The Windows desktop directory is unavailable.");
        var path = Path.Combine(desktop, FileName(browser));
        InstallerEngine.EnsureNoReparsePointsThrough(path);
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
