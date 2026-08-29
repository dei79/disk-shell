import assert from "node:assert/strict";
import test from "node:test";

import { selectMessages } from "../src/ui/i18n.js";

test("uses English by default and German only for DSM ger", () => {
  assert.equal(selectMessages("").copy, "Copy");
  assert.equal(selectMessages("enu").status.connected, "Connected");
  assert.equal(selectMessages("fre").reconnect, "Reconnect");
  assert.equal(selectMessages("ger").copy, "Kopieren");
  assert.equal(selectMessages("GER").status.connected, "Verbunden");
});
