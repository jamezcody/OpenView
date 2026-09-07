# Security policy

## Supported version

Security fixes are applied to the current v0.1.x release line. Reproduce a problem against the latest published release when practical.

## Report privately

Use the repository's GitHub private vulnerability-reporting form under **Security → Advisories → Report a vulnerability**. Do not open a public issue containing an exploitable vulnerability, credential, private location, or personal information.

Include the affected version and operating system, the smallest safe reproduction, expected and observed behavior, and whether a credential or public deployment may be exposed. Replace all live values with unmistakable placeholders.

## Security design

- OpenView requires no runtime API key.
- Runtime secrets are not embedded in browser code or generated assets.
- Optional Windows refresh credentials are stored as current-user vault entries in Windows Credential Manager.
- Endpoint overrides must use HTTPS and cannot contain user information, a query string, or a fragment.
- GitHub and Cloudflare credentials are maintainer credentials and are never installer inputs.
- Network response sizes, request bodies, concurrency, and data-page reads are bounded.
- Prepared releases use versioned manifests and SHA-256 integrity checks.
- The production application requires its Worker server and must not be deployed as only static client files.

## Release checklist

Before publication:

1. Scan the working tree, generated output, archives, and complete Git history for credentials.
2. Confirm the generated Worker configuration has no unintended variables, bindings, or secret references.
3. Run tests, type checking, linting, formatting, and the production build.
4. Verify every installer and payload SHA-256 digest.
5. Test the installer with fake sentinel credentials and confirm they do not appear in files, logs, archives, binaries, registry values, or process arguments.
6. Test credential replacement and removal under a separate Windows account.

Release executables should be Authenticode-signed when signing infrastructure is available. Unsigned builds must be labeled clearly and accompanied by a published checksum.
