# OpenView v0.1.4

The desktop browser shortcut now opens OpenView's local URL directly in your default browser. It no longer invokes the unsigned `OpenView.exe --browser` helper. Smart App Control settings are not changed.

- Creates `OpenView Browser.url` with the saved server port and the OpenView icon.
- Migrates an OpenView-owned v0.1.3 `OpenView Browser.lnk` during upgrade or settings save, creating the replacement before removing the old link.
- Updates an existing OpenView-owned URL shortcut when a new port is saved. Stop/start the server to apply the port change before using the shortcut.
- Preserves unrelated or edited shortcuts. Desktop shortcuts remain opt-in; an absent shortcut is not created just by saving settings.
- Keeps the server launcher, icons, installer auto-close, settings, credentials, application functionality, and prepared datasets unchanged.

## Upgrade

Close the OpenView controller and run `OpenView-Setup-v0.1.4.exe`. Keep the existing installation directory and select the desktop browser shortcut option if it is not already installed. Setup downloads the verified runtime/data packages, or uses the matching archives placed beside it.

Start OpenView, then use **OpenView Browser**. The URL shortcut opens the browser only; it does not start the server. This removes the browser shortcut's dependency on an unsigned helper but does not make the unsigned installer/server trusted by Smart App Control. A managed Windows policy may still restrict URL shortcuts. End-to-end behavior with Smart App Control enabled must be checked on the affected computer.

## Verification

Installer tests cover Windows URL shortcut parsing, custom ports, port updates, legacy link migration, launcher compatibility, Unicode/space-containing paths, collision protection, ownership-aware removal, and opt-in behavior. Release packaging verifies the complete runtime and data archives against the manifest. The web application and datasets reuse the v0.1.3 payload; no new map behavior is introduced.
