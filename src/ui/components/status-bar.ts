import type { ConnectionState } from "../types.js";

declare const DISKSHELL_VERSION: string;

export const statusBarComponent = {
  data() {
    return { version: DISKSHELL_VERSION };
  },
  props: {
    state: { type: String, required: true },
    text: { type: Object, required: true },
  },
  computed: {
    label(this: { state: ConnectionState; text: { status: Record<ConnectionState, string> } }): string {
      return this.text.status[this.state];
    },
  },
  template: [
    '<div class="diskshell-status" role="status" aria-live="polite">',
    '  <span class="diskshell-status-dot" :class="state" aria-hidden="true"></span>',
    '  <span>{{ label }}</span>',
    '  <span class="diskshell-status-meta">',
    '    <span class="diskshell-status-hint">{{ text.sessionHint }}</span>',
    '    <span class="diskshell-status-version">v{{ version }}</span>',
    '  </span>',
    '</div>',
  ].join(""),
};
