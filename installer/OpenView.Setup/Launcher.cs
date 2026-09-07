using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;

namespace OpenView.Setup;

internal sealed class LauncherForm : Form
{
    internal const string MutexName = @"Local\OpenView.Controller.com.jamezcody.openview";
    private string _localUrl = GetLocalUrl(AppSettings.DefaultPort);

    private readonly Label _status = new() { AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft };
    private readonly Button _start = new() { Text = "Start", AutoSize = true };
    private readonly Button _stop = new() { Text = "Stop", AutoSize = true, Enabled = false };
    private readonly Button _open = new() { Text = "Open browser", AutoSize = true, Enabled = false };
    private readonly Button _configure = new() { Text = "Settings", AutoSize = true };
    private readonly Mutex _mutex;
    private CancellationTokenSource _lifetimeCancellation = new();
    private readonly SemaphoreSlim _stopGate = new(1, 1);
    private CancellationTokenSource? _runCancellation;
    private Process? _worker;
    private KillOnCloseJob? _workerJob;
    private Task? _startTask;
    private Task? _stdoutDrain;
    private Task? _stderrDrain;
    private bool _shutdownPending;
    private bool _allowClose;

    public LauncherForm()
    {
        var mutex = TryAcquireControllerMutex()
            ?? throw new InvalidOperationException("OpenView is already running. Use the existing OpenView controller window.");
        try { InstallerEngine.ValidateInstalledLayout(AppContext.BaseDirectory); }
        catch
        {
            ReleaseControllerExclusion(mutex);
            throw;
        }
        _mutex = mutex;

        Text = $"OpenView {ReleaseConfig.Current.Version}";
        Icon = Branding.CreateIcon();
        Width = 540;
        Height = 190;
        MinimumSize = new Size(480, 170);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        _status.Text = "OpenView is stopped.";

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            AutoSize = true,
            WrapContents = false,
        };
        buttons.Controls.AddRange([_start, _stop, _open, _configure]);
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(18),
            ColumnCount = 1,
            RowCount = 3,
        };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(new Label
        {
            Text = "Local OpenView server",
            Font = new Font(Font, FontStyle.Bold),
            AutoSize = true,
        }, 0, 0);
        layout.Controls.Add(_status, 0, 1);
        layout.Controls.Add(buttons, 0, 2);
        Controls.Add(layout);

        _start.Click += (_, _) => BeginStart();
        _stop.Click += async (_, _) =>
        {
            try { await RequestStopAsync(); }
            catch (Exception error)
            {
                _status.Text = error.Message;
                MessageBox.Show(this, error.Message, "OpenView", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        };
        _open.Click += (_, _) => OpenBrowser();
        _configure.Click += (_, _) => OpenSettings();
        Shown += (_, _) => BeginStart();
        FormClosing += HandleClosing;
    }

    internal static bool IsControllerActive()
    {
        using var mutex = new Mutex(false, MutexName);
        try
        {
            if (!mutex.WaitOne(0)) return true;
            mutex.ReleaseMutex();
            return false;
        }
        catch (AbandonedMutexException)
        {
            mutex.ReleaseMutex();
            return false;
        }
    }

    internal static Mutex AcquireControllerExclusion()
    {
        return TryAcquireControllerMutex()
            ?? throw new InvalidOperationException(
                "OpenView is running. Close the OpenView controller before changing the installation.");
    }

    internal static void ReleaseControllerExclusion(Mutex mutex)
    {
        mutex.ReleaseMutex();
        mutex.Dispose();
    }

    private static Mutex? TryAcquireControllerMutex()
    {
        var mutex = new Mutex(false, MutexName);
        try
        {
            if (mutex.WaitOne(0)) return mutex;
        }
        catch (AbandonedMutexException) { return mutex; }
        mutex.Dispose();
        return null;
    }

    private void BeginStart()
    {
        if (_shutdownPending || _startTask is { IsCompleted: false } || _worker is { HasExited: false }) return;
        _startTask = StartWorkerAsync();
    }

    private async Task StartWorkerAsync()
    {
        var runCancellation = CancellationTokenSource.CreateLinkedTokenSource(_lifetimeCancellation.Token);
        _runCancellation = runCancellation;
        SetStartingState("Checking the local runtime...");
        try
        {
            var token = runCancellation.Token;
            InstallerEngine.ValidateInstalledLayout(AppContext.BaseDirectory);
            var settings = InstallerEngine.LoadSettings();
            var localUrl = GetLocalUrl(settings.Port);
            _localUrl = localUrl;
            RefuseOccupiedPort(settings.Port);
            var node = await InstallerEngine.FindNodeAsync(token);
            token.ThrowIfCancellationRequested();
            var installation = Path.GetFullPath(AppContext.BaseDirectory);
            var start = CreateWorkerStartInfo(installation, node, settings);
            token.ThrowIfCancellationRequested();

            var process = Process.Start(start)
                ?? throw new InvalidOperationException("The OpenView Worker could not be started.");
            KillOnCloseJob? job = null;
            try
            {
                job = new KillOnCloseJob();
                job.Assign(process);
            }
            catch
            {
                job?.Dispose();
                try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
                catch { }
                process.Dispose();
                throw;
            }
            _worker = process;
            _workerJob = job!;
            _stdoutDrain = DrainAsync(process.StandardOutput, token);
            _stderrDrain = DrainAsync(process.StandardError, token);
            _status.Text = "Starting the local server...";

            for (var attempt = 0; attempt < 60; attempt++)
            {
                if (process.HasExited)
                    throw new InvalidOperationException($"The local server exited with code {process.ExitCode}.");
                if (await IsOwnedRuntimeReadyAsync(process, localUrl, token))
                {
                    _status.Text = $"OpenView is running at {localUrl}";
                    _open.Enabled = true;
                    _start.Enabled = false;
                    _stop.Enabled = true;
                    _configure.Enabled = true;
                    _ = MonitorWorkerExitAsync(process);
                    return;
                }
                await Task.Delay(1000, token);
            }
            throw new InvalidOperationException("The local server did not become ready within 60 seconds.");
        }
        catch (OperationCanceledException) when (runCancellation.IsCancellationRequested)
        {
            await StopWorkerCoreAsync();
        }
        catch (Exception error)
        {
            var message = error.Message;
            try { await StopWorkerCoreAsync(); }
            catch (Exception stopError) { message += $" The local server also could not be stopped: {stopError.Message}"; }
            _status.Text = message;
            if (!_shutdownPending && !IsDisposed)
                MessageBox.Show(this, message, "OpenView", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            if (_worker is not { HasExited: false } && !_shutdownPending)
                SetStoppedState(_status.Text);
        }
    }

    private async Task RequestStopAsync()
    {
        _runCancellation?.Cancel();
        var startTask = _startTask;
        if (startTask is not null)
        {
            try { await startTask; }
            catch { }
        }
        await StopWorkerCoreAsync();
    }

    private async Task StopWorkerCoreAsync()
    {
        await _stopGate.WaitAsync();
        try
        {
            var cancellation = _runCancellation;
            cancellation?.Cancel();
            var process = _worker;
            var job = _workerJob;
            var stdout = _stdoutDrain;
            var stderr = _stderrDrain;
            if (process is not null)
            {
                try
                {
                    if (!process.HasExited) process.Kill(entireProcessTree: true);
                    job?.Dispose();
                    await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));
                }
                catch (InvalidOperationException) when (process.HasExited) { }
                catch (System.ComponentModel.Win32Exception) when (process.HasExited) { }
                catch (TimeoutException) when (process.HasExited) { }
                if (!process.HasExited)
                    throw new InvalidOperationException(
                        "The local server could not be stopped. The controller will remain open.");
                try { await Task.WhenAll(stdout ?? Task.CompletedTask, stderr ?? Task.CompletedTask); }
                catch (OperationCanceledException) { }
                process.Dispose();
            }
            else job?.Dispose();
            _worker = null;
            _workerJob = null;
            _stdoutDrain = null;
            _stderrDrain = null;
            if (ReferenceEquals(_runCancellation, cancellation)) _runCancellation = null;
            cancellation?.Dispose();
            if (!_shutdownPending && !IsDisposed) SetStoppedState();
        }
        finally { _stopGate.Release(); }
    }

    private async Task MonitorWorkerExitAsync(Process process)
    {
        int exitCode;
        try
        {
            await process.WaitForExitAsync();
            exitCode = process.ExitCode;
        }
        catch { return; }
        if (IsDisposed || !IsHandleCreated) return;
        try
        {
            BeginInvoke(async () =>
            {
                if (!ReferenceEquals(_worker, process) || _shutdownPending) return;
                try
                {
                    await StopWorkerCoreAsync();
                    _status.Text = $"The local server exited with code {exitCode}.";
                }
                catch (Exception error)
                {
                    if (IsDisposed) return;
                    _status.Text = error.Message;
                    MessageBox.Show(this, error.Message, "OpenView",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            });
        }
        catch (InvalidOperationException) { }
    }

    private void HandleClosing(object? sender, FormClosingEventArgs eventArgs)
    {
        if (_allowClose) return;
        eventArgs.Cancel = true;
        if (_shutdownPending) return;
        _shutdownPending = true;
        _lifetimeCancellation.Cancel();
        _start.Enabled = false;
        _stop.Enabled = false;
        _open.Enabled = false;
        _configure.Enabled = false;
        _status.Text = "Stopping OpenView...";
        BeginInvoke(async () =>
        {
            try
            {
                if (_startTask is not null)
                {
                    try { await _startTask; }
                    catch { }
                }
                await StopWorkerCoreAsync();
                _lifetimeCancellation.Dispose();
                _stopGate.Dispose();
                _mutex.ReleaseMutex();
                _mutex.Dispose();
                _allowClose = true;
                Close();
            }
            catch (Exception error)
            {
                var cancelledLifetime = _lifetimeCancellation;
                _lifetimeCancellation = new CancellationTokenSource();
                cancelledLifetime.Dispose();
                _shutdownPending = false;
                _status.Text = error.Message;
                _stop.Enabled = _worker is not null;
                _start.Enabled = _worker is null;
                _configure.Enabled = true;
                MessageBox.Show(this, error.Message, "OpenView", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        });
    }

    private void SetStartingState(string message)
    {
        _status.Text = message;
        _start.Enabled = false;
        _stop.Enabled = true;
        _configure.Enabled = false;
        _open.Enabled = false;
    }

    private void SetStoppedState(string? message = null)
    {
        _status.Text = message ?? "OpenView is stopped.";
        _start.Enabled = true;
        _stop.Enabled = false;
        _open.Enabled = false;
        _configure.Enabled = true;
    }

    internal static string GetLocalUrl(int port) =>
        $"http://127.0.0.1:{AppSettings.ValidatePort(port).ToString(CultureInfo.InvariantCulture)}/";

    internal static void RefuseOccupiedPort(int port)
    {
        AppSettings.ValidatePort(port);
        TcpListener? listener = null;
        try
        {
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Server.ExclusiveAddressUse = true;
            listener.Start();
        }
        catch (SocketException)
        {
            throw new InvalidOperationException(
                $"TCP port {port} is unavailable or already in use. Choose another Server port in Settings, save it, then start OpenView again.");
        }
        finally { listener?.Stop(); }
    }

    internal static ProcessStartInfo CreateWorkerStartInfo(string installation, string node, AppSettings settings)
    {
        var port = AppSettings.ValidatePort(settings.Port);
        var photonUrl = InstallerEngine.ValidatePhotonUrl(settings.PhotonApiUrl);
        var wrangler = InstallerEngine.CombineUnderRoot(installation, "node_modules/wrangler/bin/wrangler.js");
        var config = InstallerEngine.CombineUnderRoot(installation, "dist/server/wrangler.json");
        var start = new ProcessStartInfo(node)
        {
            WorkingDirectory = installation,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var argument in new[]
        {
            wrangler, "dev", "--config", config, "--ip", "127.0.0.1", "--port", port.ToString(CultureInfo.InvariantCulture),
            "--log-level", "error",
        }) start.ArgumentList.Add(argument);
        if (photonUrl.Length != 0)
        {
            start.ArgumentList.Add("--var");
            start.ArgumentList.Add($"PHOTON_API_URL:{photonUrl}");
        }
        InstallerEngine.SanitizeEnvironment(start);
        return start;
    }

    internal static async Task<bool> IsOwnedRuntimeReadyAsync(Process worker, string localUrl, CancellationToken cancellationToken)
    {
        if (worker.HasExited) return false;
        try
        {
            using var handler = new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false };
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(2) };
            using var root = await client.GetAsync(localUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!root.IsSuccessStatusCode || worker.HasExited) return false;

            var probe = ReleaseConfig.Current.RuntimeProbe;
            var probeUrl = localUrl.TrimEnd('/') + probe.Path;
            using var response = await client.GetAsync(probeUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!response.IsSuccessStatusCode || worker.HasExited) return false;
            if (response.Content.Headers.ContentLength is > 1024 * 1024) return false;
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var memory = new MemoryStream();
            var buffer = new byte[81920];
            while (true)
            {
                var read = await stream.ReadAsync(buffer, cancellationToken);
                if (read == 0) break;
                if (memory.Length + read > 1024 * 1024) return false;
                memory.Write(buffer, 0, read);
            }
            var actual = SHA256.HashData(memory.GetBuffer().AsSpan(0, checked((int)memory.Length)));
            return CryptographicOperations.FixedTimeEquals(actual, Convert.FromHexString(probe.Sha256));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { return false; }
        catch (HttpRequestException) { return false; }
        catch (IOException) { return false; }
    }

    private static async Task DrainAsync(StreamReader reader, CancellationToken cancellationToken)
    {
        var buffer = new char[4096];
        while (await reader.ReadAsync(buffer, cancellationToken) != 0) { }
    }

    private void OpenBrowser() =>
        Process.Start(new ProcessStartInfo(_localUrl) { UseShellExecute = true });

    private static void OpenSettings()
    {
        var executable = Environment.ProcessPath
            ?? throw new InvalidOperationException("The OpenView executable path is unavailable.");
        _ = Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true });
    }
}
