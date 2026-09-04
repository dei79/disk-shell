import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';

test('drops target the hovered visible pane, regardless of active pane', () => {
  class Element {
    constructor(canvas) { this.canvas = canvas; }
    closest() { return this.canvas; }
  }
  const source = readFileSync(new URL('../src/ui/components/terminal-view.ts', import.meta.url), 'utf8');
  const module = { exports: {} };
  runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, require: () => ({}), Element,
  });
  const resolve = module.exports.terminalViewComponent.methods.dropTab;
  const first = { id: 1, connectionState: 'connected' };
  const second = { id: 2, connectionState: 'connected' };
  const canvas = { dataset: { tabId: '2' } };
  const view = {
    activeTabId: 1, tabs: [first, second],
    isTabVisible: () => true,
    $refs: { terminalHost: { contains: (candidate) => candidate === canvas } },
  };
  const event = { target: new Element(canvas) };
  assert.equal(resolve.call(view, event), second);
  canvas.dataset.tabId = '1';
  assert.equal(resolve.call(view, event), first);
  assert.equal(resolve.call(view, { target: new Element(null) }), null);
  view.isTabVisible = () => false;
  assert.equal(resolve.call(view, event), null);
  view.isTabVisible = () => true;
  first.connectionState = 'disconnected';
  assert.equal(resolve.call(view, event), null);
  first.connectionState = 'connected';
  for (const state of ['uploading', 'checkingUpload', 'pendingUpload']) {
    view[state] = true;
    assert.equal(resolve.call(view, event), null);
    view[state] = false;
  }
});
