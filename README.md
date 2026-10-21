# DiskShell

A secure, native terminal for the Synology DSM desktop. DiskShell gives DSM
users a modern multi-tab shell with persistent sessions, split views,
search, uploads, and explicit clipboard controls—without exposing a separate
terminal port on the network.

![DiskShell showing a system overview and backup monitor in a side-by-side shell view](docs/disk-shell-screenshot.png)

## Features

- **Multiple shell tabs** — work in up to four independent terminals in one DSM
  window and rename them for quick orientation.
- **Background sessions** — keep a shell and its processes running after its tab
  or the DiskShell window is closed, then reopen it later.
- **Split view** — place two existing tabs side by side or one above the other,
  with clear pane ownership and independent terminal sizing.
- **Terminal search** — search each tab's scrollback with `⌘F` or `Ctrl+F` and
  navigate between matches.
- **Drag-and-drop uploads** — securely upload files into the active shell's
  current directory.
- **Deliberate clipboard access** — Copy & Paste remains disabled until it is
  explicitly enabled for the current DiskShell window.
- **DSM-native authentication** — requires a valid DSM session and
  starts the shell under the authenticated DSM account.
- **Live system monitor** — automatically scaled one-minute histories per logical CPU core and for
  RAM usage, the fullest NAS volume, fastest fan, and hottest drive sensor;
  values stream every two seconds over an authenticated WebSocket. Click a widget
  for scrollable individual readings. A shared sampler avoids per-window polling;
  DSM sessions are revalidated every minute; temporary lookup failures reconnect with backoff.
  A monotonic graph clock and sample sequence numbers tolerate NAS clock corrections.
  History resets on service restart and otherwise survives reconnects
  and shows gaps where no readings were collected. Hidden monitors suspend their
  connections, and sampling pauses when no monitors are subscribed.
  Fans and disk temperatures require readable Linux hwmon sensors; unsupported
  hardware (including VirtualDSM) shows an unavailable indicator.
- **Responsive toolbar** — accessible icon controls, state-aware tooltips, and a
  compact layout that adapts to the DSM window. Monitor widgets disappear from
  right to left as the window narrows: drive temperature, fans, volume usage,
  RAM, then CPU.

Sudo shells can be opened with **plus with shield** beside the new-tab button. DiskShell
starts sudo as the authenticated DSM account; sudo applies its normal policy.
The password dialog sends the credential over the authenticated connection to a
one-shot stdin pipe for sudo, separately from terminal input. Background persistence
is opt-in for these tabs too. File uploads still use the DSM account permissions.

## Installation

DiskShell currently targets **DSM 7.2 on x86_64 Synology systems**.

1. Download the latest `.spk` and its checksum from
   [GitHub Releases](https://github.com/dei79/disk-shell/releases/latest).
2. Verify the downloaded package against the `.sha256` file.
3. In DSM, open **Package Center → Manual Install** and select the SPK.
4. Launch **DiskShell** from the DSM main menu while signed in to DSM.

DiskShell's service listens only on `127.0.0.1:16082`. DSM's nginx proxy exposes
the application under `/diskshell/`; no additional network port is published.

## Build from source

### Requirements

- Node.js 22 or newer
- npm
- Go 1.26 or newer
- GNU `tar`

Install dependencies, validate the project, and build an SPK:

```sh
npm ci
npm run check
npm test
npm run build
```

The package is written to:

```text
build/DiskShell-<version>-<revision>.spk
```

When multiple Go toolchains are installed, select one explicitly:

```sh
DISKSHELL_GO_BINARY=/path/to/go npm run build
```

Use a unique package revision for every package installed on a live DSM system.
This prevents DSM from reusing cached JavaScript or CSS assets:

```sh
DISKSHELL_PACKAGE_REVISION=42 npm run build
```

## Architecture and security

The browser UI is written in TypeScript and SCSS and uses xterm.js. A compact Go
service validates the active DSM session through `authenticate.cgi` and launches
`/bin/sh -l` under the authenticated account through a pseudo-terminal. The setuid
service drops privileges using that account's UID, GID, and supplementary groups,
and uses its home directory (falling back to `/tmp` if unavailable).

DiskShell does not automatically grant root privileges. Filesystem access and
command permissions are those of the authenticated DSM user. Administrator
accounts retain whatever privileges DSM and Unix normally give them.

Important boundaries include:

- same-origin checks for terminal, session, and upload requests;
- bounded WebSocket messages, terminal output buffers, uploads, and concurrent
  shell sessions;
- per-account ownership for sessions and uploaded files;
- no DSM tokens in nginx access logs;
- a loopback-only backend behind DSM's existing web proxy.

Background sessions live inside the DiskShell service. They survive browser and
DiskShell window closures, but not a package restart, DSM reboot, or service
failure.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/ui/` | DSM desktop UI, terminal components, styles, and translations |
| `native/` | Go HTTP/WebSocket service, session manager, PTY, and uploads |
| `payload/` | Files installed into the SPK payload |
| `conf/` | DSM package permissions and resource declarations |
| `scripts/` | DSM package lifecycle and service scripts |
| `test/` | Package, security-boundary, and integration tests |
| `build.mjs` | Deterministic frontend, native binary, and SPK build |

## Live DSM verification

Use a disposable DSM test system and a unique package revision. After
installation:

1. Confirm `/diskshell/health` returns `{"status":"ok"}` through the DSM URL.
2. Open DiskShell as a normal DSM user and run:

   ```sh
   printf '__DISKSHELL_OK__\n'
   id
   stty size
   ```

3. Verify the marker, the account's UID, GID and groups, and a non-zero terminal
   size. Confirm its home directory and normal filesystem permissions.
4. Resize the DSM window and verify `stty size` changes accordingly.
5. Repeat with an administrator account and confirm its own credentials.
6. Confirm neither account can list, reconnect to, rename, terminate, or upload
   into the other account's sessions.

## Contributing

Contributions are welcome. Keep changes focused and preserve the authentication
and privilege boundaries.

1. Fork the repository and create a feature branch.
2. Install dependencies with `npm ci`.
3. Make the change and add or update relevant tests.
4. Run `npm run check` and `npm test`.
5. Open a pull request describing the behavior, security impact, and DSM testing
   performed.

Please do not test package installation on a production NAS.

## Releases

The version in `package.json` must match the semantic Git tag. Pushing a tag such
as `v1.3.0` runs the release workflow, builds revision `1`, generates a SHA-256
checksum, and publishes both files as a GitHub Release.

Before tagging a release:

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` together.
2. Run `npm ci`, `npm run check`, and `npm test` (including the native tests on Linux).
3. Build with `DISKSHELL_PACKAGE_REVISION=1 npm run build` and verify the SPK on a disposable DSM system.
4. Commit the release preparation, then create and push the matching version tag when ready to publish.

The default package revision is `1`; use a higher explicit revision for subsequent
builds installed under the same version. Updating the package restarts its service
and ends all active shells, including background sessions.

## License

DiskShell is available under the [MIT License](LICENSE).
