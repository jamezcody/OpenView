# OpenView v0.1.2

Version 0.1.2 lets you choose the local server port in the Windows installer and change it later through the OpenView controller's settings. It includes the map fixes and prepared datasets from v0.1.1.

## Choose or change the port

- Enter **Server port** before clicking **Install / repair**. The default is `8787`; selecting `8080` hosts the app at `http://127.0.0.1:8080/`.
- To change an installed copy, select **Settings → Save configuration**, then **Stop → Start** after entering the new port. The browser button uses the current running port until restart.
- Ports must be whole numbers from `1` to `65535`. Setup rejects browser-blocked ports, and the controller reports when the chosen port is unavailable.
- OpenView continues to listen only on `127.0.0.1`. Choosing a port does not enable access from other computers.
- The installer scrolls on shorter displays so the port and existing configuration controls remain reachable.

## Upgrade from v0.1.1

Close the OpenView controller and run `OpenView-Setup-v0.1.2.exe` from the download location. Keep the existing installation folder, choose a port, and click **Install / repair**. Settings without a saved port continue to use `8787`. Optional saved credentials are preserved unless their replacement boxes are checked.

The installer, runtime and data archives, manifest, and SHA-256 checksum list are published as separate v0.1.2 assets. The original v0.1.1 release remains available. The installer is unsigned.

## Verification

Installer self-tests cover default and legacy settings, custom-port serialization, invalid and browser-blocked ports, and occupied-port detection. A complete temporary installation with the full datasets started successfully on custom port `43212` in 24.17 seconds, within the controller's 60-second startup limit. The root HTTP response and favicon checksum passed the production readiness checks. The test stopped its worker, released the port, removed its temporary installation, and verified that existing settings, registry entries, shortcuts, and the running preview were unchanged.

The application fixes and data checks from the previous release are recorded in [the v0.1.1 release notes](RELEASE_v0.1.1.md).
