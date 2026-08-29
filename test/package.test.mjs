import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const integration = resolve(import.meta.dirname, "..");
const packageVersion = JSON.parse(readFileSync(join(integration, "package.json"), "utf8")).version;
const testRevision = "900000";

test("builds a self-contained DSM Terminal SPK", () => {
  const output = execFileSync(process.execPath, [join(integration, "build.mjs")], {
    cwd: integration,
    encoding: "utf8",
    env: { ...process.env, DSM_TERMINAL_PACKAGE_REVISION: testRevision },
  }).trim();
  const spk = join(integration, output);
  assert.equal(existsSync(spk), true);
  const extraction = mkdtempSync(join(tmpdir(), "dsm-terminal-test-"));
  try {
    execFileSync("tar", ["-xf", spk, "-C", extraction]);
    const outer = execFileSync("tar", ["-tf", spk], { encoding: "utf8" });
    for (const entry of ["INFO", "package.tgz", "conf/privilege", "conf/resource", "scripts/start-stop-status"]) {
      assert.match(outer, new RegExp(`^${entry}$`, "mu"));
    }
    const payload = execFileSync("tar", ["-tzf", join(extraction, "package.tgz")], { encoding: "utf8" });
    for (const entry of [
      "bin/dsm-terminal-server",
      "nginx/dsm-terminal.conf",
      `ui/DSMTerminal-${packageVersion}-${testRevision}.js`,
      `ui/DSMTerminal-${packageVersion}-${testRevision}.css`,
      "ui/config",
      "ui/images/icon_64.png",
    ]) assert.match(payload, new RegExp(`^${entry}$`, "mu"));
    assert.match(readFileSync(join(extraction, "INFO"), "utf8"), new RegExp(`version="${packageVersion}-${testRevision}"`, "u"));
    const privilege = JSON.parse(readFileSync(join(extraction, "conf/privilege"), "utf8"));
    assert.ok(privilege.tool.some((tool) => tool.relpath === "bin/dsm-terminal-server" && tool.user === "root" && tool.permission === "4750"));
    const resource = JSON.parse(readFileSync(join(extraction, "conf/resource"), "utf8"));
    assert.equal("systemd-user-unit" in resource, false);
  } finally {
    rmSync(extraction, { force: true, recursive: true });
  }
});

test("keeps terminal authentication and transport boundaries explicit", () => {
  const backend = readFileSync(join(integration, "native/main.go"), "utf8");
  assert.match(backend, /authenticate\.cgi/u);
  assert.match(backend, /administrators/u);
  assert.match(backend, /CheckOrigin:\s+allowedOrigin/u);
  assert.match(backend, /SetReadLimit\(maxMessageSize\)/u);
  assert.match(backend, /syscall\.Credential/u);
  assert.match(backend, /os\.Getuid\(\) == os\.Geteuid\(\)/u);
  assert.doesNotMatch(backend, /SetReadDeadline/u);
  assert.doesNotMatch(backend, /command\.Env = append\(os\.Environ/u);
  assert.doesNotMatch(backend, /exec\.Command\([^\n]*message\.Data/u);
});

test("sends the fitted terminal size as soon as the websocket opens", () => {
  const view = readFileSync(join(integration, "src/ui/components/terminal-view.ts"), "utf8");
  const openHandler = view.slice(view.indexOf("onOpen:"), view.indexOf("onClose:"));
  assert.match(openHandler, /this\.fit\(\)/u);
  assert.match(openHandler, /type: "resize"/u);
  assert.match(openHandler, /this\.terminal\?\.cols/u);
  assert.match(openHandler, /this\.terminal\?\.rows/u);
});

test("fits the terminal from container-driven DSM window resizes", () => {
  const view = readFileSync(join(integration, "src/ui/components/terminal-view.ts"), "utf8");
  const styles = readFileSync(join(integration, "src/ui/styles/main.scss"), "utf8");
  assert.match(view, /ResizeObserver\(\(\) => this\.scheduleFit\(\)\)/u);
  assert.match(view, /requestAnimationFrame/u);
  assert.match(styles, /container:\s*dsm-terminal\s*\/\s*inline-size/u);
  assert.match(styles, /@container dsm-terminal \(max-width: 520px\)/u);
  assert.doesNotMatch(styles, /min-height:\s*420px/u);
});
