import assert from "node:assert/strict";
import test from "node:test";

import { selectMessages } from "../src/ui/i18n.js";

test("uses English by default and German only for DSM ger", () => {
  assert.equal(selectMessages("").allowClipboard, "Allow Copy & Paste");
  assert.equal(selectMessages("enu").status.connected, "Connected");
  assert.equal(selectMessages("fre").reconnect, "Reconnect");
  assert.equal(selectMessages("ger").allowClipboard, "Copy & Paste erlauben");
  assert.equal(selectMessages("ger").keepAlive, "Im Hintergrund behalten");
  assert.equal(selectMessages("enu").hideTab, "Hide tab");
  assert.equal(selectMessages("GER").status.connected, "Verbunden");
});
