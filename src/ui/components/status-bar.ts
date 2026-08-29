import type { ConnectionState } from "../types.js";

export const statusBarComponent = {
  props: {
    state: { type: String, required: true },
  },
  computed: {
    label(this: { state: ConnectionState }): string {
      return {
        connecting: "Verbindung wird hergestellt …",
        connected: "Verbunden",
        disconnected: "Verbindung beendet",
        error: "Verbindungsfehler",
      }[this.state];
    },
  },
  template: [
    '<div class="dsm-terminal-status" role="status" aria-live="polite">',
    '  <span class="dsm-terminal-status-dot" :class="state" aria-hidden="true"></span>',
    '  <span>{{ label }}</span>',
    '  <span class="dsm-terminal-status-hint">DSM-Administratorkonto · verschlüsselt über die aktuelle DSM-Sitzung</span>',
    '</div>',
  ].join(""),
};
