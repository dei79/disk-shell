# Security Policy

DiskShell provides an administrator shell inside Synology DSM. Security reports
are taken seriously, especially when they concern authentication, authorization,
session isolation, uploads, WebSocket connections, or command execution.

## Supported versions

Security fixes are provided for the latest published DiskShell release. Please
reproduce an issue with the latest release before reporting it whenever possible.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/dei79/disk-shell/issues/new) and prefix
the title with `[Security]`.

Please include:

- the DiskShell and DSM versions;
- the Synology model and CPU architecture;
- a clear description of the issue and its potential impact;
- minimal steps required to reproduce it;
- any known workaround or mitigation.

GitHub issues are public. Never include passwords, DSM session tokens, cookies,
private keys, personal file contents, public IP addresses, internal hostnames, or
other sensitive system information. Sanitize logs and screenshots before
attaching them. If full reproduction details would put users at immediate risk,
open an issue containing only a brief impact summary and state that the remaining
details are sensitive.

The report will be assessed and tracked in the issue. Confirmed vulnerabilities
will be addressed in a supported release and documented in the corresponding
release notes.

## Security updates

Install security-related DiskShell releases promptly. Release packages and their
SHA-256 checksums are published on the
[GitHub Releases page](https://github.com/dei79/disk-shell/releases).
