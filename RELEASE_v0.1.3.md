# OpenView v0.1.3

Download `OpenView-Setup-v0.1.3.exe` from this release. Setup downloads its checksum-pinned runtime and data archives automatically when they are not beside the executable.

- Uses the supplied `OpenView_logo.png` for the Windows executable/window icons, setup logo, browser icon, and GitHub README branding.
- Names the app OpenView and updates repository references to `jamezcody/OpenView`.
- Closes setup automatically after successful installation, launching the controller first when selected. Configuration warnings are shown before closing; failed or cancelled installations remain open.
- Offers independent, opt-in desktop shortcuts for the launcher and browser. The launcher starts the local server. The browser shortcut opens the saved port using the default browser; start the server first. Change the port in Settings and restart the server before using the browser shortcut.
- Keeps the executable in the installation folder; desktop links point to it. Existing unrelated desktop shortcuts are not overwritten, and uninstall removes only links that still target this installation.

Existing port validation, optional credentials, loopback-only hosting, map fixes, and prepared datasets are preserved. The installer is unsigned.

## Local verification

- TypeScript, lint, formatting, production build, source/generated credential audits, and Windows installer build passed.
- Packaged installer self-tests verified both archive sidecars, the embedded logo/icon, port/settings rules, and real Windows shortcuts in an isolated temporary folder. Tests covered shortcut targets, arguments, icons, repeat creation, collision protection, and ownership-aware removal.
- Setup was rendered at full and compact window sizes; both shortcut options are independently available and unchecked by default.
- A separate runtime smoke test on port `43213` passed in 3.13 seconds, verifying the OpenView title, icon URL, original logo checksum, and production readiness probe. Its process stopped and port was released; existing settings, registration, Start menu links, and desktop links were unchanged.
- Full archive validation/extraction passed, but the end-to-end installation trial correctly stopped at activation because an existing OpenView controller was running. It cleaned up its temporary files without changing the installed app. Close the controller before testing installation, desktop integration, and automatic setup closing. Full-dataset startup was not established by the separate runtime smoke test.
- The GitHub repository rename is complete. The old v0.1.2 manifest download still matches its published SHA-256 through the old URL. Earlier releases remain unchanged.

## Install and test

1. Close the existing OpenView controller.
2. Download and run `OpenView-Setup-v0.1.3.exe`. For an offline install, download both `.tar.gz` archives from this release and leave them beside setup. Node.js 22.13 or newer must already be installed.
3. Keep the existing installation directory and desired port; select either or both desktop shortcut options.
4. Click **Install / repair**. On success, setup should close; the controller should open if selected.
5. Test the launcher and browser shortcuts. The browser shortcut requires the server to be running. After changing the port, save settings and stop/start the server before testing the browser shortcut again.
