using System.Diagnostics;

namespace OpenView.Setup;

internal static class Uninstaller
{
    public static int Run()
    {
        var installation = Path.GetFullPath(AppContext.BaseDirectory)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        ValidateInstalledExecutable(installation);
        if (LauncherForm.IsControllerActive())
            throw new InvalidOperationException(
                "OpenView is still running. Close the OpenView controller window, then uninstall again.");

        var choice = MessageBox.Show(
            "Remove OpenView, its local configuration, and saved Windows credentials for this user?",
            "Uninstall OpenView",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (choice != DialogResult.Yes) return 0;

        var currentExecutable = Path.GetFullPath(Environment.ProcessPath
            ?? throw new InvalidOperationException("The OpenView executable path is unavailable."));
        var helper = Path.Combine(Path.GetTempPath(), $"OpenView-Uninstall-{Guid.NewGuid():N}.exe");
        File.Copy(currentExecutable, helper, false);
        var start = new ProcessStartInfo(helper)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        start.ArgumentList.Add("--complete-uninstall");
        start.ArgumentList.Add(installation);
        start.ArgumentList.Add(Environment.ProcessId.ToString());
        _ = Process.Start(start)
            ?? throw new InvalidOperationException("The OpenView removal helper could not start.");
        return 0;
    }

    internal static async Task<int> CompleteAsync(string target, int parentProcessId)
    {
        try
        {
            target = InstallerEngine.ValidateInstallDirectory(target);
            InstallerEngine.ValidateInstalledLayout(target);
            InstallerEngine.EnsureNoReparseTree(target);

            try
            {
                using var parent = Process.GetProcessById(parentProcessId);
                await parent.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(2));
            }
            catch (ArgumentException) { }

            var controllerExclusion = LauncherForm.AcquireControllerExclusion();
            try
            {
                // Revalidate while holding the launch exclusion, after the original executable exits.
                InstallerEngine.ValidateInstalledLayout(target);
                InstallerEngine.EnsureNoReparseTree(target);
                string lastError = "unknown error";
                for (var attempt = 0; attempt < 12; attempt++)
                {
                    if (InstallerEngine.TrySafeDeleteDirectory(target, out lastError)) break;
                    Thread.Sleep(500);
                }
                if (Directory.Exists(target))
                    throw new IOException($"OpenView could not be removed: {lastError}");
            }
            finally { LauncherForm.ReleaseControllerExclusion(controllerExclusion); }

            var warnings = new List<string>();
            try { CredentialManager.RemoveAll(); }
            catch (Exception error) { warnings.Add(error.Message); }
            warnings.AddRange(InstallerEngine.RemoveShellAndUserDataBestEffort());
            if (warnings.Count != 0)
            {
                Console.Error.WriteLine("OpenView was removed, but some per-user integration remains: " + string.Join("; ", warnings));
                MessageBox.Show(
                    "OpenView was removed, but some per-user cleanup needs attention:" +
                    Environment.NewLine + Environment.NewLine + string.Join(Environment.NewLine, warnings.Select(value => "• " + value)),
                    "OpenView removal", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            else
                MessageBox.Show("OpenView was removed.", "OpenView removal", MessageBoxButtons.OK, MessageBoxIcon.Information);
            ScheduleHelperSelfDelete();
            return warnings.Count == 0 ? 0 : 2;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            MessageBox.Show(error.Message, "OpenView removal failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
            ScheduleHelperSelfDelete();
            return 1;
        }
    }

    private static void ValidateInstalledExecutable(string installation)
    {
        InstallerEngine.ValidateInstalledLayout(installation);
        var expected = Path.GetFullPath(Path.Combine(installation, InstallerEngine.InstalledExecutableName));
        var current = Path.GetFullPath(Environment.ProcessPath
            ?? throw new InvalidOperationException("The OpenView executable path is unavailable."));
        if (!string.Equals(expected, current, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Uninstall must be started from the installed OpenView executable.");
    }

    private static void ScheduleHelperSelfDelete()
    {
        var helper = Environment.ProcessPath;
        if (string.IsNullOrEmpty(helper) || !Path.GetFileName(helper).StartsWith("OpenView-Uninstall-", StringComparison.Ordinal))
            return;
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(powershell)) return;
        var start = new ProcessStartInfo(powershell)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        foreach (var argument in new[]
        {
            "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
            "Start-Sleep -Seconds 2; Remove-Item -LiteralPath $env:OPENVIEW_UNINSTALL_HELPER -Force",
        }) start.ArgumentList.Add(argument);
        start.Environment.Clear();
        start.Environment["OPENVIEW_UNINSTALL_HELPER"] = helper;
        _ = Process.Start(start);
    }
}
