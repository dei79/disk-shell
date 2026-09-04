import assert from "node:assert/strict";
import test from "node:test";

import { handleSearchShortcutEvent } from "../src/ui/search-shortcuts.ts";

function keyEvent(key, overrides = {}) {
  const calls = { prevented: 0, stopped: 0 };
  return {
    calls,
    event: {
      type: "keydown",
      key,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      preventDefault() { calls.prevented += 1; },
      stopImmediatePropagation() { calls.stopped += 1; },
      ...overrides,
    },
  };
}

function context(searchOpen) {
  const calls = { opened: 0, closed: 0 };
  return {
    calls,
    value: {
      searchOpen,
      targetIsInside: true,
      openSearch() { calls.opened += 1; },
      closeSearch() { calls.closed += 1; },
    },
  };
}

test("Escape closes an open terminal search before DSM can handle the key", () => {
  const { calls, value } = context(true);
  const { calls: eventCalls, event } = keyEvent("Escape");

  assert.equal(handleSearchShortcutEvent(value, event), true);
  assert.deepEqual(calls, { opened: 0, closed: 1 });
  assert.deepEqual(eventCalls, { prevented: 1, stopped: 1 });
});

test("Escape remains available to the terminal when search is closed", () => {
  const { calls, value } = context(false);
  const { calls: eventCalls, event } = keyEvent("Escape");

  assert.equal(handleSearchShortcutEvent(value, event), false);
  assert.deepEqual(calls, { opened: 0, closed: 0 });
  assert.deepEqual(eventCalls, { prevented: 0, stopped: 0 });
});
