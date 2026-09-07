using System.Diagnostics;
using System.Drawing;

namespace OpenView.Setup;

internal sealed class InstallerForm : Form
{
    private readonly TextBox _installDirectory = new() { Dock = DockStyle.Fill };
    private readonly Button _browseButton = new() { AutoSize = true, Text = "Browse..." };
    private readonly TextBox _photonUrl = new() { Dock = DockStyle.Fill };
    private readonly CheckBox _replaceFcc = new() { AutoSize = true, Text = "Replace saved FCC credential" };
    private readonly Label _fccStatus = new() { AutoSize = true, ForeColor = SystemColors.GrayText };
    private readonly TextBox _fccUsername = new() { Dock = DockStyle.Fill, Enabled = false };
    private readonly TextBox _fccToken = new() { Dock = DockStyle.Fill, Enabled = false, UseSystemPasswordChar = true };
    private readonly CheckBox _replaceOpenCellId = new() { AutoSize = true, Text = "Replace saved OpenCellID credential" };
    private readonly Label _openCellIdStatus = new() { AutoSize = true, ForeColor = SystemColors.GrayText };
    private readonly TextBox _openCellIdToken = new() { Dock = DockStyle.Fill, Enabled = false, UseSystemPasswordChar = true };
    private readonly CheckBox _launchAfterInstall = new()
    {
        AutoSize = true,
        Checked = true,
        Text = "Launch OpenView after installation",
    };
    private readonly Button _installButton = new() { AutoSize = true, Text = "Install / repair" };
    private readonly Button _saveButton = new() { AutoSize = true, Text = "Save configuration" };
    private readonly Button _launchButton = new() { AutoSize = true, Text = "Launch installed app" };
    private readonly Button _removeCredentialsButton = new() { AutoSize = true, Text = "Remove saved credentials" };
    private readonly ProgressBar _progressBar = new()
    {
        Dock = DockStyle.Fill,
        MarqueeAnimationSpeed = 28,
        Style = ProgressBarStyle.Marquee,
        Visible = false,
    };
    private readonly Label _status = new()
    {
        AutoEllipsis = true,
        AutoSize = false,
        Dock = DockStyle.Fill,
        Text = "Ready.",
        TextAlign = ContentAlignment.MiddleLeft,
    };
    private CancellationTokenSource? _activeOperation;
    private bool _closeWhenOperationEnds;

    public InstallerForm()
    {
        Text = $"OpenView {ReleaseConfig.Current.Version} Setup";
        ClientSize = new Size(780, 690);
        MinimumSize = new Size(740, 650);
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false;
        Font = new Font("Segoe UI", 9F);
        Padding = new Padding(24);

        _installDirectory.Text = InstallerEngine.DiscoverInstallDirectory();
        try { _photonUrl.Text = InstallerEngine.LoadPhotonUrl(); }
        catch (Exception error) { _status.Text = $"Existing settings could not be loaded: {error.Message}"; }

        _browseButton.Click += BrowseClicked;
        _replaceFcc.CheckedChanged += (_, _) => UpdateCredentialInputs();
        _replaceOpenCellId.CheckedChanged += (_, _) => UpdateCredentialInputs();
        _installButton.Click += InstallClicked;
        _saveButton.Click += SaveClicked;
        _launchButton.Click += LaunchClicked;
        _removeCredentialsButton.Click += RemoveCredentialsClicked;
        _installDirectory.TextChanged += (_, _) => RefreshActions();
        FormClosing += OnFormClosing;

        var locationRow = new TableLayoutPanel { AutoSize = true, ColumnCount = 2, Dock = DockStyle.Fill };
        locationRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        locationRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        locationRow.Controls.Add(_installDirectory, 0, 0);
        locationRow.Controls.Add(_browseButton, 1, 0);

        var credentials = new TableLayoutPanel
        {
            AutoSize = true,
            ColumnCount = 2,
            Dock = DockStyle.Fill,
            Padding = new Padding(14, 4, 0, 0),
        };
        credentials.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 180));
        credentials.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        credentials.Controls.Add(_replaceFcc, 0, 0);
        credentials.SetColumnSpan(_replaceFcc, 1);
        credentials.Controls.Add(_fccStatus, 1, 0);
        AddField(credentials, "FCC username", _fccUsername, 1);
        AddField(credentials, "FCC API token", _fccToken, 2);
        credentials.Controls.Add(_replaceOpenCellId, 0, 3);
        credentials.Controls.Add(_openCellIdStatus, 1, 3);
        AddField(credentials, "OpenCellID API token", _openCellIdToken, 4);

        var buttons = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = true,
        };
        buttons.Controls.AddRange([_installButton, _saveButton, _launchButton, _removeCredentialsButton]);

        var layout = new TableLayoutPanel { ColumnCount = 1, Dock = DockStyle.Fill, RowCount = 14 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 16));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 14));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        layout.Controls.Add(new Label
        {
            AutoSize = true,
            Font = new Font(Font.FontFamily, 20F, FontStyle.Bold),
            Text = "OpenView setup and settings",
        }, 0, 0);
        layout.Controls.Add(new Label
        {
            AutoSize = true,
            MaximumSize = new Size(720, 0),
            ForeColor = Color.FromArgb(26, 102, 66),
            Font = new Font(Font, FontStyle.Bold),
            Text = "The production app runs locally and requires no API keys.",
        }, 0, 1);
        layout.Controls.Add(new Label { AutoSize = true, Text = "Installation directory" }, 0, 3);
        layout.Controls.Add(locationRow, 0, 4);
        layout.Controls.Add(new Label { AutoSize = true, Text = "PHOTON_API_URL (optional, non-secret)" }, 0, 6);
        layout.Controls.Add(_photonUrl, 0, 7);
        layout.Controls.Add(new Label
        {
            AutoSize = true,
            ForeColor = SystemColors.GrayText,
            MaximumSize = new Size(720, 0),
            Text = "Leave blank for the built-in default. Only an HTTPS URL without user info, query parameters, or a fragment is accepted.",
        }, 0, 8);
        layout.Controls.Add(new Label
        {
            AutoSize = true,
            MaximumSize = new Size(720, 0),
            Padding = new Padding(0, 8, 0, 0),
            Text = "Optional credentials are only for offline acquisition tools. Check a replacement box to overwrite a saved credential; unchecked credentials are preserved.",
        }, 0, 9);
        layout.Controls.Add(credentials, 0, 10);
        layout.Controls.Add(_launchAfterInstall, 0, 11);
        layout.Controls.Add(_progressBar, 0, 12);

        var bottom = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill };
        bottom.Controls.Add(_status, 0, 0);
        bottom.Controls.Add(buttons, 0, 1);
        layout.Controls.Add(bottom, 0, 13);
        Controls.Add(layout);

        AcceptButton = _installButton;
        RefreshCredentialStatus();
        UpdateCredentialInputs();
        RefreshActions();
    }

    private static void AddField(TableLayoutPanel panel, string label, Control control, int row)
    {
        panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        panel.Controls.Add(new Label
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            Text = label,
            TextAlign = ContentAlignment.MiddleLeft,
        }, 0, row);
        panel.Controls.Add(control, 1, row);
    }

    private void BrowseClicked(object? sender, EventArgs eventArgs)
    {
        using var picker = new FolderBrowserDialog
        {
            Description = "Choose a dedicated OpenView installation directory",
            InitialDirectory = _installDirectory.Text,
            ShowNewFolderButton = true,
        };
        if (picker.ShowDialog(this) == DialogResult.OK) _installDirectory.Text = picker.SelectedPath;
    }

    private async void InstallClicked(object? sender, EventArgs eventArgs)
    {
        var installed = false;
        try
        {
            var url = ValidateConfigurationInputs();
            _activeOperation = new CancellationTokenSource();
            SetBusy(true);
            var result = await InstallerEngine.InstallAsync(
                new InstallOptions(_installDirectory.Text, url),
                new Progress<string>(message => _status.Text = message),
                _activeOperation.Token);
            installed = true;
            _installDirectory.Text = result.InstallDirectory;

            var configurationWarnings = new List<string>(result.Warnings);
            try { ApplyCredentialReplacements(); }
            catch (Exception error) { configurationWarnings.Add($"Credentials were not fully saved: {error.Message}"); }
            ClearCredentialEntryFields();
            RefreshCredentialStatus();

            _status.Text = configurationWarnings.Count == 0
                ? "Installation complete."
                : "Installed with configuration warnings.";
            var message = $"OpenView {ReleaseConfig.Current.Version} was installed successfully.";
            if (configurationWarnings.Count != 0)
                message += Environment.NewLine + Environment.NewLine + string.Join(Environment.NewLine, configurationWarnings.Select(w => "• " + w));
            MessageBox.Show(this, message, "OpenView Setup", MessageBoxButtons.OK,
                configurationWarnings.Count == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            if (_launchAfterInstall.Checked) StartInstalledLauncher(result.InstallDirectory);
        }
        catch (OperationCanceledException)
        {
            _status.Text = "Installation cancelled.";
        }
        catch (Exception error)
        {
            _status.Text = installed ? "The app was installed, but configuration failed." : "Installation failed.";
            MessageBox.Show(this, error.Message, "OpenView Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _activeOperation?.Dispose();
            _activeOperation = null;
            SetBusy(false);
            if (_closeWhenOperationEnds) BeginInvoke(Close);
        }
    }

    private async void SaveClicked(object? sender, EventArgs eventArgs)
    {
        try
        {
            var url = ValidateConfigurationInputs();
            _activeOperation = new CancellationTokenSource();
            SetBusy(true);
            await InstallerEngine.WriteSettingsAsync(url, _activeOperation.Token);
            ApplyCredentialReplacements();
            ClearCredentialEntryFields();
            RefreshCredentialStatus();
            _status.Text = "Configuration saved.";
        }
        catch (OperationCanceledException) { _status.Text = "Configuration save cancelled."; }
        catch (Exception error)
        {
            _status.Text = "Configuration was not fully saved.";
            MessageBox.Show(this, error.Message, "OpenView", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _activeOperation?.Dispose();
            _activeOperation = null;
            SetBusy(false);
            if (_closeWhenOperationEnds) BeginInvoke(Close);
        }
    }

    private string ValidateConfigurationInputs()
    {
        var url = InstallerEngine.ValidatePhotonUrl(_photonUrl.Text);
        if (_replaceFcc.Checked) CredentialManager.ValidateFccReplacement(_fccUsername.Text, _fccToken.Text);
        if (_replaceOpenCellId.Checked) CredentialManager.ValidateOpenCellIdReplacement(_openCellIdToken.Text);
        return url;
    }

    private void ApplyCredentialReplacements()
    {
        if (_replaceFcc.Checked) CredentialManager.SaveFcc(_fccUsername.Text, _fccToken.Text);
        if (_replaceOpenCellId.Checked) CredentialManager.SaveOpenCellId(_openCellIdToken.Text);
    }

    private void ClearCredentialEntryFields()
    {
        _fccUsername.Clear();
        _fccToken.Clear();
        _openCellIdToken.Clear();
        _replaceFcc.Checked = false;
        _replaceOpenCellId.Checked = false;
    }

    private void LaunchClicked(object? sender, EventArgs eventArgs)
    {
        try
        {
            var directory = InstallerEngine.ValidateInstallDirectory(_installDirectory.Text);
            InstallerEngine.ValidateInstalledLayout(directory);
            StartInstalledLauncher(directory);
        }
        catch (Exception error)
        {
            MessageBox.Show(this, error.Message, "OpenView", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void RemoveCredentialsClicked(object? sender, EventArgs eventArgs)
    {
        if (MessageBox.Show(this,
            "Remove both optional OpenView offline-refresh credentials for this Windows user?",
            "Remove saved credentials", MessageBoxButtons.YesNo, MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
        try
        {
            CredentialManager.RemoveAll();
            ClearCredentialEntryFields();
            RefreshCredentialStatus();
            _status.Text = "Saved OpenView credentials removed.";
        }
        catch (Exception error)
        {
            MessageBox.Show(this, error.Message, "OpenView", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void RefreshCredentialStatus()
    {
        try
        {
            _fccStatus.Text = CredentialManager.HasFcc ? "Saved" : "Not saved";
            _openCellIdStatus.Text = CredentialManager.HasOpenCellId ? "Saved" : "Not saved";
        }
        catch
        {
            _fccStatus.Text = "Status unavailable";
            _openCellIdStatus.Text = "Status unavailable";
        }
    }

    private void UpdateCredentialInputs()
    {
        var idle = _activeOperation is null;
        _fccUsername.Enabled = idle && _replaceFcc.Checked;
        _fccToken.Enabled = idle && _replaceFcc.Checked;
        _openCellIdToken.Enabled = idle && _replaceOpenCellId.Checked;
    }

    private static void StartInstalledLauncher(string directory)
    {
        var executable = Path.Combine(directory, InstallerEngine.InstalledExecutableName);
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = true,
            WorkingDirectory = directory,
        };
        start.ArgumentList.Add("--launch");
        _ = Process.Start(start);
    }

    private void SetBusy(bool busy)
    {
        _installDirectory.Enabled = !busy;
        _browseButton.Enabled = !busy;
        _photonUrl.Enabled = !busy;
        _replaceFcc.Enabled = !busy;
        _replaceOpenCellId.Enabled = !busy;
        _saveButton.Enabled = !busy;
        _removeCredentialsButton.Enabled = !busy;
        _launchAfterInstall.Enabled = !busy;
        if (busy)
        {
            _installButton.Enabled = false;
            _launchButton.Enabled = false;
        }
        _progressBar.Visible = busy;
        UseWaitCursor = busy;
        UpdateCredentialInputs();
        if (!busy) RefreshActions();
    }

    private void RefreshActions()
    {
        if (_activeOperation is not null)
        {
            _installButton.Enabled = false;
            _launchButton.Enabled = false;
            return;
        }
        try
        {
            var selected = InstallerEngine.ValidateInstallDirectory(_installDirectory.Text);
            var current = Environment.ProcessPath ?? string.Empty;
            _installButton.Enabled = !InstallerEngine.IsPathInside(current, selected);
            _launchButton.Enabled = InstallerEngine.IsInstalled(selected);
            if (!_installButton.Enabled)
                _status.Text = "This installed copy can edit settings or launch OpenView. Use downloaded setup to repair it.";
        }
        catch
        {
            _installButton.Enabled = false;
            _launchButton.Enabled = false;
        }
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs eventArgs)
    {
        if (_activeOperation is null) return;
        eventArgs.Cancel = true;
        if (MessageBox.Show(this, "Cancel the current operation and close setup?", "OpenView Setup",
            MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
        _closeWhenOperationEnds = true;
        _activeOperation.Cancel();
    }
}
