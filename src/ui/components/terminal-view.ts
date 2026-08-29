import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import { TerminalSocket } from "../services/terminal-socket.js";
import type { ConnectionState } from "../types.js";
import { statusBarComponent } from "./status-bar.js";

type TerminalView = {
  connectionState: ConnectionState;
  errorMessage: string;
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  terminalSocket: TerminalSocket | null;
  resizeObserver: ResizeObserver | null;
  connect(): void;
  fit(): void;
};

export const terminalViewComponent = {
  components: { "terminal-status-bar": statusBarComponent },
  template: [
    '<section class="dsm-terminal-shell">',
    '  <header class="dsm-terminal-toolbar">',
    '    <div><strong>DSM Terminal</strong><span>Interaktive Shell auf deinem NAS</span></div>',
    '    <div class="dsm-terminal-actions">',
    '      <button type="button" @click="copySelection" :disabled="!connected">Kopieren</button>',
    '      <button type="button" @click="pasteClipboard" :disabled="!connected">Einfügen</button>',
    '      <button type="button" class="primary" @click="connect" v-if="!connected">Neu verbinden</button>',
    '    </div>',
    '  </header>',
    '  <div v-if="errorMessage" class="dsm-terminal-alert" role="alert">{{ errorMessage }}</div>',
    '  <div ref="terminal" class="dsm-terminal-canvas" aria-label="Interaktives DSM-Terminal"></div>',
    '  <terminal-status-bar :state="connectionState"></terminal-status-bar>',
    '</section>',
  ].join(""),
  data() {
    return {
      connectionState: "connecting" as ConnectionState,
      errorMessage: "",
      terminal: null as Terminal | null,
      fitAddon: null as FitAddon | null,
      terminalSocket: null as TerminalSocket | null,
      resizeObserver: null as ResizeObserver | null,
    };
  },
  computed: {
    connected(this: TerminalView): boolean {
      return this.connectionState === "connected";
    },
  },
  mounted(this: TerminalView & { $refs: { terminal: HTMLElement } }): void {
    this.terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      minimumContrastRatio: 7,
      scrollback: 5000,
      theme: {
        background: "#111820",
        foreground: "#e6edf3",
        cursor: "#61dafb",
        cursorAccent: "#111820",
        selectionBackground: "#35546f",
      },
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.$refs.terminal);
    this.terminal.onData((data) => this.terminalSocket?.send({ type: "input", data }));
    this.terminal.onResize(({ cols, rows }) => this.terminalSocket?.send({ type: "resize", cols, rows }));
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.$refs.terminal);
    this.fit();
    this.connect();
  },
  beforeDestroy(this: TerminalView): void {
    this.resizeObserver?.disconnect();
    this.terminalSocket?.disconnect();
    this.terminal?.dispose();
  },
  methods: {
    connect(this: TerminalView): void {
      this.connectionState = "connecting";
      this.errorMessage = "";
      this.terminal?.clear();
      this.terminal?.write("\x1b[38;5;81mDSM Terminal\x1b[0m – Verbindung wird hergestellt …\r\n");
      this.terminalSocket = new TerminalSocket({
        onOpen: () => {
          this.connectionState = "connected";
          this.errorMessage = "";
          this.fit();
          this.terminalSocket?.send({
            type: "resize",
            cols: this.terminal?.cols || 120,
            rows: this.terminal?.rows || 36,
          });
          this.terminal?.focus();
        },
        onClose: () => {
          if (this.connectionState !== "error") this.connectionState = "disconnected";
        },
        onOutput: (data) => this.terminal?.write(data),
        onError: (message) => {
          this.connectionState = "error";
          this.errorMessage = message;
        },
      });
      this.terminalSocket.connect();
    },
    fit(this: TerminalView): void {
      if (!this.fitAddon || !this.terminal) return;
      try {
        this.fitAddon.fit();
      } catch {
        // DSM can briefly report a zero-sized window during its opening animation.
      }
    },
    async copySelection(this: TerminalView): Promise<void> {
      const selection = this.terminal?.getSelection() || "";
      if (selection) await navigator.clipboard.writeText(selection);
    },
    async pasteClipboard(this: TerminalView): Promise<void> {
      const value = await navigator.clipboard.readText();
      if (value) this.terminal?.paste(value);
    },
  },
};
