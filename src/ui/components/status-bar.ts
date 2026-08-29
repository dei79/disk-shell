import type { ConnectionState } from "../types.js";

export const statusBarComponent = {
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
    '<div class="dsm-terminal-status" role="status" aria-live="polite">',
    '  <span class="dsm-terminal-status-dot" :class="state" aria-hidden="true"></span>',
    '  <span>{{ label }}</span>',
    '  <span class="dsm-terminal-status-hint">{{ text.sessionHint }}</span>',
    '</div>',
  ].join(""),
};
