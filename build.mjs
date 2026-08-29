#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { compile as compileSass } from "sass";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const metadata = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const packageRevision = process.env.DSM_TERMINAL_PACKAGE_REVISION || "13";
const spkVersion = `${metadata.version}-${packageRevision}`;
const buildRoot = join(here, "build");
const staging = join(buildRoot, "staging");
const payload = join(buildRoot, "payload");
const output = join(buildRoot, `DSMTerminal-${spkVersion}.spk`);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function renderIcon(size) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const normalizedX = x / size;
      const normalizedY = y / size;
      const inside = normalizedX > 0.08 && normalizedX < 0.92 && normalizedY > 0.08 && normalizedY < 0.92;
      const chevron = inside && normalizedX > 0.23 && normalizedX < 0.53
        && Math.abs(normalizedY - (normalizedX < 0.38 ? normalizedX + 0.12 : 0.88 - normalizedX)) < 0.045;
      const underscore = inside && normalizedX > 0.5 && normalizedX < 0.75 && normalizedY > 0.65 && normalizedY < 0.71;
      const color = !inside ? [0, 0, 0, 0] : chevron || underscore ? [97, 218, 251, 255] : [24, 34, 45, 255];
      row.set(color, 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function directorySize(directory) {
  let bytes = 0;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const info = statSync(path);
    bytes += info.isDirectory() ? directorySize(path) : info.size;
  }
  return bytes;
}

function archive(outputPath, cwd, entries, compressed = false) {
  const argumentsList = [compressed ? "-czf" : "-cf", outputPath, "--format=ustar", "--no-recursion"];
  const visit = (entry) => {
    argumentsList.push(entry);
    const path = join(cwd, entry);
    if (statSync(path).isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(entry, child));
    }
  };
  for (const entry of entries) visit(entry);
  execFileSync("tar", argumentsList, { cwd, env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: "inherit" });
}

rmSync(buildRoot, { force: true, recursive: true });
mkdirSync(staging, { recursive: true });
cpSync(join(here, "conf"), join(staging, "conf"), { recursive: true });
cpSync(join(here, "scripts"), join(staging, "scripts"), { recursive: true });
cpSync(join(here, "payload"), payload, { recursive: true });
copyFileSync(join(here, "LICENSE"), join(staging, "LICENSE"));

const scriptName = `DSMTerminal-${spkVersion}.js`;
const styleName = `DSMTerminal-${spkVersion}.css`;
await build({
  entryPoints: [join(here, "src/ui/app.ts")],
  outfile: join(payload, "ui", scriptName),
  bundle: true,
  format: "iife",
  legalComments: "none",
  minify: false,
  platform: "browser",
  sourcemap: false,
  target: "chrome100",
});
const xtermStyles = readFileSync(join(here, "node_modules/@xterm/xterm/css/xterm.css"), "utf8");
const applicationStyles = compileSass(join(here, "src/ui/styles/main.scss"), { style: "compressed" }).css;
writeFileSync(join(payload, "ui", styleName), `${xtermStyles}\n${applicationStyles}`);

const scriptPath = join(payload, "ui", scriptName);
writeFileSync(
  scriptPath,
  readFileSync(scriptPath, "utf8").replace("webman/3rdparty/DSMTerminal/style.css", `webman/3rdparty/DSMTerminal/${styleName}`),
);
const configPath = join(payload, "ui/config");
const config = JSON.parse(readFileSync(configPath, "utf8"));
config[scriptName] = config["DSMTerminal.js"];
delete config["DSMTerminal.js"];
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

mkdirSync(join(payload, "bin"), { recursive: true });
execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w -buildid=", "-o", join(payload, "bin/dsm-terminal-server"), "./native"], {
  cwd: here,
  env: { ...process.env, CGO_ENABLED: "0", GOARCH: "amd64", GOOS: "linux" },
  stdio: "inherit",
});

for (const script of readdirSync(join(staging, "scripts"))) chmodSync(join(staging, "scripts", script), 0o755);
chmodSync(join(payload, "bin/dsm-terminal-server"), 0o755);
const images = join(payload, "ui/images");
mkdirSync(images, { recursive: true });
for (const size of [16, 24, 32, 48, 64, 72, 128, 256]) writeFileSync(join(images, `icon_${size}.png`), renderIcon(size));
writeFileSync(join(staging, "PACKAGE_ICON.PNG"), renderIcon(64));
writeFileSync(join(staging, "PACKAGE_ICON_256.PNG"), renderIcon(256));

const extractSize = Math.max(1, Math.ceil(directorySize(payload) / 1024));
archive(join(staging, "package.tgz"), payload, readdirSync(payload).sort(), true);
rmSync(payload, { force: true, recursive: true });
const info = readFileSync(join(here, "INFO.template"), "utf8")
  .replaceAll("@SPK_VERSION@", spkVersion)
  .replaceAll("@EXTRACT_SIZE@", String(extractSize));
writeFileSync(join(staging, "INFO"), info);
archive(output, staging, ["INFO", "package.tgz", "scripts", "conf", "LICENSE", "PACKAGE_ICON.PNG", "PACKAGE_ICON_256.PNG"]);

if (!existsSync(output)) throw new Error("DSM Terminal SPK build did not produce an output file.");
process.stdout.write(`${relative(here, output)}\n`);
