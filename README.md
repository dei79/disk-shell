# DiskShell

Native DSM 7.2 desktop terminal packaged as an SPK. The browser UI is written in
TypeScript and SCSS and uses xterm.js. A small Go service authenticates the active
DSM session, permits administrators only, and launches `/bin/sh` under the
authenticated DSM account through a pseudo-terminal.

## Local build

```sh
npm install
npm run check
npm test
npm run build
```

The SPK is written to `build/DiskShell-<version>-<revision>.spk`. Increment
the default `packageRevision` in `build.mjs` before creating another installable package build so DSM does
not reuse cached desktop assets.

The service listens only on `127.0.0.1:16082`. DSM's nginx proxy exposes the
WebSocket under `/diskshell/`; it is not a separately published network port.

## Live DSM verification

Use only a disposable DSM test system. Configure `BURSULA_TEST_VM_URL`,
`BURSULA_TEST_VM_USERNAME`, and `BURSULA_TEST_VM_PASSWORD` in the ignored `.env`
file, build a new package revision, and install the SPK through Package Center or
`synopkg`.

After installation:

1. Confirm `/diskshell/health` returns `{"status":"ok"}` through the DSM URL.
2. Open **DiskShell** from the DSM main menu as an administrator and run
   `printf '__DISKSHELL_OK__\\n'; id -un; stty size`.
3. Verify the marker, the logged-in DSM account, and a non-zero terminal size are
   printed, then resize the window and run `stty size` again.
4. Verify a same-host request without a DSM session gets HTTP 401 and a request
   with `Origin: https://attacker.example` gets HTTP 403.
5. Log in with a disposable non-administrator account and confirm that the
   terminal refuses the connection and never presents a shell prompt.

Keep the package revision unique for every live run so DSM does not reuse cached
JavaScript or CSS assets.
