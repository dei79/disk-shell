#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const goBinary = process.env.DISKSHELL_GO_BINARY || "go";

execFileSync(goBinary, ["test", "./native"], {
  cwd: new URL("..", import.meta.url),
  env: process.env,
  stdio: "inherit",
});
