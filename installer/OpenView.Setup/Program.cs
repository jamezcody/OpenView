namespace OpenView.Setup;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
        {
            try { return SelfTest.Run(args); }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                return 1;
            }
        }

        var acceptanceIndex = Array.FindIndex(args,
            value => value.Equals("--acceptance-test", StringComparison.OrdinalIgnoreCase));
        if (acceptanceIndex >= 0)
        {
            try
            {
                if (acceptanceIndex + 1 >= args.Length)
                    throw new InvalidOperationException("--acceptance-test requires a temporary target directory.");
                return SelfTest.RunAcceptanceAsync(args[acceptanceIndex + 1]).GetAwaiter().GetResult();
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                return 1;
            }
        }

        var completeIndex = Array.FindIndex(args,
            value => value.Equals("--complete-uninstall", StringComparison.OrdinalIgnoreCase));
        if (completeIndex >= 0)
        {
            try
            {
                ApplicationConfiguration.Initialize();
                if (completeIndex + 2 >= args.Length || !int.TryParse(args[completeIndex + 2], out var parentId))
                    throw new InvalidOperationException("The internal uninstall request is invalid.");
                return Uninstaller.CompleteAsync(args[completeIndex + 1], parentId).GetAwaiter().GetResult();
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                return 1;
            }
        }

        ApplicationConfiguration.Initialize();
        try
        {
            if (args.Contains("--launch", StringComparer.OrdinalIgnoreCase))
            {
                Application.Run(new LauncherForm());
                return 0;
            }
            if (args.Contains("--uninstall", StringComparer.OrdinalIgnoreCase))
                return Uninstaller.Run();

            Application.Run(new InstallerForm());
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "OpenView", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
