import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import { TerminalSocket } from "../services/terminal-socket.js";
import { messages } from "../i18n.js";
import type { Messages } from "../i18n.js";
import type { ConnectionState } from "../types.js";
import { statusBarComponent } from "./status-bar.js";

type TerminalView = {
  connectionState: ConnectionState;
  text: Messages;
  errorMessage: string;
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  terminalSocket: TerminalSocket | null;
  resizeObserver: ResizeObserver | null;
  fitFrame: number | null;
  connect(): void;
  fit(): void;
  scheduleFit(): void;
};

export const terminalViewComponent = {
  components: { "terminal-status-bar": statusBarComponent },
  template: [
    '<section class="diskshell-shell">',
    '  <header class="diskshell-toolbar">',
    '    <div><strong>DiskShell</strong><span>{{ text.subtitle }}</span></div>',
    '    <div class="diskshell-actions">',
    '      <button type="button" @click="copySelection" :disabled="!connected">{{ text.copy }}</button>',
    '      <button type="button" @click="pasteClipboard" :disabled="!connected">{{ text.paste }}</button>',
    '      <button type="button" class="primary" @click="connect" v-if="!connected">{{ text.reconnect }}</button>',
    '    </div>',
    '  </header>',
    '  <div v-if="errorMessage" class="diskshell-alert" role="alert">{{ errorMessage }}</div>',
    '  <div ref="terminal" class="diskshell-canvas" :aria-label="text.terminalAriaLabel"></div>',
    '  <terminal-status-bar :state="connectionState" :text="text"></terminal-status-bar>',
    '</section>',
  ].join(""),
  data() {
    return {
      connectionState: "connecting" as ConnectionState,
      text: messages,
      errorMessage: "",
      terminal: null as Terminal | null,
      fitAddon: null as FitAddon | null,
      terminalSocket: null as TerminalSocket | null,
      resizeObserver: null as ResizeObserver | null,
      fitFrame: null as number | null,
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
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.$refs.terminal);
    this.scheduleFit();
    this.connect();
  },
  beforeDestroy(this: TerminalView): void {
    this.resizeObserver?.disconnect();
    if (this.fitFrame !== null) cancelAnimationFrame(this.fitFrame);
    this.terminalSocket?.disconnect();
    this.terminal?.dispose();
  },
  methods: {
    connect(this: TerminalView): void {
      this.connectionState = "connecting";
      this.errorMessage = "";
      this.terminal?.clear();
      this.terminal?.write(`\x1b[38;5;81mDiskShell\x1b[0m – ${this.text.connectingTerminal}\r\n`);
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
    scheduleFit(this: TerminalView): void {
      if (this.fitFrame !== null) cancelAnimationFrame(this.fitFrame);
      this.fitFrame = requestAnimationFrame(() => {
        this.fitFrame = null;
        this.fit();
      });
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
