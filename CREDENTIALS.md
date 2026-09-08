# Credentials and configuration

Credential names in this document are identifiers, never credential values.

OpenView supports `AISSTREAM_API_KEY`, required for AISStream's ten-minute ship snapshots but optional for OpenView itself. Create your own key at [AISStream Account](https://aisstream.io/account), then check **Set AISStream key** in setup/settings and enter it in the masked field. Windows installs read it from `OpenView/AISStream` in Windows Credential Manager. The local Node collector alone uses the key; it is not passed to Vite, Wrangler, browser assets or runtime archives. Restart the server after changing it. `AISSTREAM_ENABLED=false` disables this provider in source runs. Digitraffic remains available without a key. See [Ship configuration](SHIPS.md).

## No key is required to run OpenView

The browser, Worker, included prepared datasets, base maps, and local fallback imagery require no user API key. The release contains no non-empty Cesium Ion token, Worker secret binding, committed environment file, FCC credential, or OpenCellID credential.

## Inventory

| Name                   |             Used by runtime | Classification     | Purpose                                                           |
| ---------------------- | --------------------------: | ------------------ | ----------------------------------------------------------------- |
| `PHOTON_API_URL`       |                    Optional | Non-secret setting | Select an operator-managed HTTPS Photon endpoint                  |
| `AISSTREAM_API_KEY`    | Required for AISStream only | Secret             | Local ten-minute AISStream collection; not needed for Digitraffic |
| `FCC_USERNAME`         |                          No | Account identifier | Separate offline FCC dataset acquisition                          |
| `FCC_API_TOKEN`        |                          No | Secret             | Separate offline FCC dataset acquisition                          |
| `OPENCELLID_API_TOKEN` |                          No | Secret             | Separate offline OpenCellID acquisition                           |

The supported FCC rebuild entry point in `tools/radio-data` accepts verified local archives and performs no network acquisition. The OpenCellID acquisition tools are not included. Prepared-data reload buttons only reread local release manifests; they never contact FCC or OpenCellID acquisition services.

Links to third-party property portals may require those sites' own accounts. OpenView does not request, receive, or store those logins.

## Windows installer storage

The optional advanced installer page stores optional AISStream runtime and offline-refresh credentials as current-user vault entries using Generic Credentials in Windows Credential Manager:

- `OpenView/FCC`
- `OpenView/OpenCellID`
- `OpenView/AISStream` (optional runtime ship collector)

Secret inputs are masked. Values are not written to the installation directory, `settings.json`, logs, command-line arguments, browser storage, release archives, or Git.

The optional non-secret `PHOTON_API_URL` setting is stored under `%LOCALAPPDATA%\OpenView\config\settings.json`. It must be an absolute HTTPS URL with no user information, query string, or fragment. Do not put a credential in any part of this URL.

The installer also stores the non-secret server `port` in that settings file. It defaults to `8787` and accepts integers from `1` to `65535`, except ports blocked by browsers. Existing settings without a port continue to use `8787`. After saving a new port in the controller's **Settings**, stop and start the server to apply it. The server continues to bind only to `127.0.0.1` on this computer.

GitHub and Cloudflare authentication are maintainer concerns, never installer inputs. Use their official credential managers or CLI authentication; the OpenView installer never requests or stores them.

## Local development

Keep every local `.env*` and `.dev.vars*` file ignored. The committed `.dev.vars.example` deliberately contains no value. Never place a secret in a `NEXT_PUBLIC_*`, `VITE_*`, or other client-visible variable.

Run the value-suppressing audit before a commit:

```powershell
npm run security:audit
npm run build
npm run security:audit:generated
```

## Rotation and removal

Use Windows Credential Manager or the installer's **Remove saved credentials** action to remove saved OpenView vault entries. Rerun the installer and explicitly enter a replacement to update an entry.

If a real credential is exposed, revoke or rotate it with the provider immediately, remove it from the working tree and Git history, and repeat the audit before publication. Do not reproduce the value in an issue, commit message, screenshot, or incident note.
