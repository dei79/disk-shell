import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const integration = resolve(import.meta.dirname, "..");
const packageVersion = JSON.parse(readFileSync(join(integration, "package.json"), "utf8")).version;
const testRevision = "900000";

test("builds a self-contained DiskShell SPK", () => {
  const output = execFileSync(process.execPath, [join(integration, "build.mjs")], {
    cwd: integration,
    encoding: "utf8",
    env: { ...process.env, DISKSHELL_PACKAGE_REVISION: testRevision },
  }).trim();
  const spk = join(integration, output);
  assert.equal(existsSync(spk), true);
  const extraction = mkdtempSync(join(tmpdir(), "diskshell-test-"));
  try {
    execFileSync("tar", ["-xf", spk, "-C", extraction]);
    const outer = execFileSync("tar", ["-tf", spk], { encoding: "utf8" });
    for (const entry of ["INFO", "package.tgz", "conf/privilege", "conf/resource", "scripts/start-stop-status"]) {
      assert.match(outer, new RegExp(`^${entry}$`, "mu"));
    }
    const payload = execFileSync("tar", ["-tzf", join(extraction, "package.tgz")], { encoding: "utf8" });
    for (const entry of [
      "bin/diskshell-server",
      "nginx/diskshell.conf",
      `ui/DiskShell-${packageVersion}-${testRevision}.js`,
      `ui/DiskShell-${packageVersion}-${testRevision}.css`,
      "ui/config",
      "ui/images/icon_64.png",
    ]) assert.match(payload, new RegExp(`^${entry}$`, "mu"));
    const info = readFileSync(join(extraction, "INFO"), "utf8");
    assert.match(info, /^package="DiskShell"$/mu);
    assert.match(info, /^displayname="DiskShell"$/mu);
    assert.match(info, /^dsmappname="SYNO\.SDS\.App\.DiskShell\.Instance"$/mu);
    assert.match(info, new RegExp(`version="${packageVersion}-${testRevision}"`, "u"));
    const privilege = JSON.parse(readFileSync(join(extraction, "conf/privilege"), "utf8"));
    assert.ok(privilege.tool.some((tool) => tool.relpath === "bin/diskshell-server" && tool.user === "root" && tool.permission === "4750"));
    const resource = JSON.parse(readFileSync(join(extraction, "conf/resource"), "utf8"));
    assert.equal("systemd-user-unit" in resource, false);
  } finally {
    rmSync(extraction, { force: true, recursive: true });
  }
});

test("keeps terminal authentication and transport boundaries explicit", () => {
  const backend = ["main.go", "session.go"]
    .map((file) => readFileSync(join(integration, "native", file), "utf8"))
    .join("\n");
  assert.match(backend, /authenticate\.cgi/u);
  assert.match(backend, /administrators/u);
  assert.match(backend, /CheckOrigin:\s+allowedOrigin/u);
  assert.match(backend, /SetReadLimit\(maxMessageSize\)/u);
  assert.match(backend, /syscall\.Credential/u);
  assert.match(backend, /os\.Getuid\(\) == os\.Geteuid\(\)/u);
  assert.match(backend, /context\.WithTimeout/u);
  assert.match(backend, /CommandContext/u);
  assert.match(backend, /SetReadDeadline/u);
  assert.match(backend, /SetPongHandler/u);
  assert.match(backend, /maxConcurrentShells/u);
  assert.match(backend, /upgradeHeader\.Set\("Sec-WebSocket-Protocol", selectedProtocol\)/u);
  assert.doesNotMatch(backend, /command\.Env = append\(os\.Environ/u);
  assert.doesNotMatch(backend, /exec\.Command\([^\n]*message\.Data/u);
});

test("requires a supported Go toolchain for package builds", () => {
  const directory = mkdtempSync(join(tmpdir(), "diskshell-old-go-"));
  try {
    const fakeGo = join(directory, "go");
    writeFileSync(fakeGo, "#!/bin/sh\nprintf 'go version go1.25.9 darwin/arm64\\n'\n");
    chmodSync(fakeGo, 0o700);
    const result = spawnSync(process.execPath, [join(integration, "build.mjs")], {
      cwd: integration,
      encoding: "utf8",
      env: { ...process.env, DISKSHELL_GO_BINARY: fakeGo },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires Go 1\.26\.0 or newer/u);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("prevents DSM tokens from entering nginx access logs", () => {
  const nginx = readFileSync(join(integration, "payload/nginx/diskshell.conf"), "utf8");
  const socket = readFileSync(join(integration, "src/ui/services/terminal-socket.ts"), "utf8");
  assert.match(nginx, /access_log\s+off;/u);
  assert.doesNotMatch(socket, /\?SynoToken=/u);
  assert.match(socket, /diskshell\.syno-token\./u);
});

test("sends the fitted terminal size as soon as the websocket opens", () => {
  const view = readFileSync(join(integration, "src/ui/components/terminal-view.ts"), "utf8");
  const openHandler = view.slice(view.indexOf("onOpen:"), view.indexOf("onClose:"));
  assert.match(openHandler, /this\.fit\(\)/u);
  assert.match(openHandler, /type: "resize"/u);
  assert.match(openHandler, /tab\.terminal\?\.cols/u);
  assert.match(openHandler, /tab\.terminal\?\.rows/u);
});

test("fits the terminal from container-driven DSM window resizes", () => {
  const view = readFileSync(join(integration, "src/ui/components/terminal-view.ts"), "utf8");
  const styles = readFileSync(join(integration, "src/ui/styles/main.scss"), "utf8");
  assert.match(view, /ResizeObserver\(\(\) => this\.scheduleFit\(\)\)/u);
  assert.match(view, /requestAnimationFrame/u);
  assert.match(styles, /container:\s*diskshell\s*\/\s*inline-size/u);
  assert.match(styles, /@container diskshell \(max-width: 520px\)/u);
  assert.doesNotMatch(styles, /min-height:\s*420px/u);
});

test("keeps the status bar compact when the optional alert is absent", () => {
  const styles = readFileSync(join(integration, "src/ui/styles/main.scss"), "utf8");
  assert.match(styles, /\.diskshell-toolbar\s*\{[^}]*grid-row:\s*1/u);
  assert.match(styles, /\.diskshell-tabs\s*\{[^}]*grid-row:\s*2/u);
  assert.match(styles, /\.diskshell-alert\s*\{[^}]*grid-row:\s*3/u);
  assert.match(styles, /\.diskshell-terminal-host\s*\{[^}]*grid-row:\s*4/u);
  assert.match(styles, /\.diskshell-status\s*\{[^}]*grid-row:\s*5/u);
});

test("keeps one independent terminal connection per shell tab", () => {
  const view = readFileSync(join(integration, "src/ui/components/terminal-view.ts"), "utf8");
  assert.match(view, /const maxTabs = 4/u);
  assert.match(view, /v-for="tab in tabs"/u);
  assert.match(view, /terminalSocket: null/u);
  assert.match(view, /tab\.terminalSocket\?\.disconnect\(\)/u);
  assert.match(view, /if \(this\.tabs\.length === 0\) this\.addTab\(\)/u);
});

test("gates terminal clipboard shortcuts behind one explicit action", () => {
  const view = readFileSync(join(integration, "src/ui/components/terminal-view.ts"), "utf8");
  assert.match(view, /allowClipboard/u);
  assert.match(view, /attachCustomKeyEventHandler/u);
  assert.match(view, /event\.ctrlKey && event\.shiftKey/u);
  assert.match(view, /navigator\.clipboard\.writeText/u);
  assert.match(view, /navigator\.clipboard\.readText/u);
  assert.doesNotMatch(view, /copySelection|pasteClipboard/u);
});

test("separates persistent shell sessions from websocket lifetimes", () => {
  const backend = readFileSync(join(integration, "native/session.go"), "utf8");
  const view = readFileSync(join(integration, "src/ui/components/terminal-view.ts"), "utf8");
  const socket = readFileSync(join(integration, "src/ui/services/terminal-socket.ts"), "utf8");
  assert.match(backend, /type sessionManager struct/u);
  assert.match(backend, /maxSessionOutput/u);
  assert.match(backend, /session\.persistent/u);
  assert.match(view, /togglePersistent/u);
  assert.match(view, /hidePendingTab/u);
  assert.match(view, /backgroundSessions/u);
  assert.match(socket, /listBackgroundSessions/u);
  assert.match(socket, /type: "open"/u);
});

test("renames open and background shell sessions", () => {
  const backend = readFileSync(join(integration, "native", "main.go"), "utf8");
  const view = readFileSync(join(integration, "src/ui/components/terminal-view.ts"), "utf8");
  const socket = readFileSync(join(integration, "src/ui/services/terminal-socket.ts"), "utf8");
  assert.match(backend, /http\.MethodPatch/u);
  assert.match(view, /beginTabRename/u);
  assert.match(view, /beginSessionRename/u);
  assert.match(socket, /renameBackgroundSession/u);
});

test("searches each terminal tab independently", () => {
  const view = readFileSync(join(integration, "src/ui/components/terminal-view.ts"), "utf8");
  assert.match(view, /SearchAddon/u);
  assert.match(view, /searchQuery: ""/u);
  assert.match(view, /findNext/u);
  assert.match(view, /findPrevious/u);
  assert.match(view, /event\.shiftKey && event\.key\.toLowerCase\(\) === "f"/u);
});

test("uploads dropped files through an authenticated bounded endpoint", () => {
  const backend = readFileSync(join(integration, "native", "upload.go"), "utf8");
  const view = readFileSync(join(integration, "src/ui/components/terminal-view.ts"), "utf8");
  const socket = readFileSync(join(integration, "src/ui/services/terminal-socket.ts"), "utf8");
  assert.match(backend, /maxUploadFileSize/u);
  assert.match(backend, /authenticateWithSlot/u);
  assert.match(backend, /os\.O_EXCL/u);
  assert.match(view, /handleDrop/u);
  assert.match(view, /shellQuote/u);
  assert.match(socket, /X-Syno-Token/u);
});
