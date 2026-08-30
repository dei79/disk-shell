import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import { TerminalSocket } from "../services/terminal-socket.js";
import { messages } from "../i18n.js";
import type { Messages } from "../i18n.js";
import type { ConnectionState } from "../types.js";
import { statusBarComponent } from "./status-bar.js";

const maxTabs = 4;

type ShellTab = {
  id: number;
  title: string;
  connectionState: ConnectionState;
  errorMessage: string;
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  terminalSocket: TerminalSocket | null;
};

type TerminalView = {
  text: Messages;
  tabs: ShellTab[];
  activeTabId: number;
  nextTabId: number;
  clipboardEnabled: boolean;
  resizeObserver: ResizeObserver | null;
  fitFrame: number | null;
  $refs: { terminalHost: HTMLElement; terminalCanvases: HTMLElement | HTMLElement[] };
  $nextTick(callback: () => void): void;
  activeTab: ShellTab | null;
  addTab(): void;
  closeTab(tabId: number): void;
  connectTab(tab: ShellTab): void;
  initializeTab(tabId: number): void;
  handleClipboardShortcut(tab: ShellTab, event: KeyboardEvent): boolean;
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
    '      <button type="button" @click="allowClipboard" :disabled="clipboardEnabled">{{ clipboardEnabled ? text.clipboardAllowed : text.allowClipboard }}</button>',
    '      <button type="button" class="primary" @click="connect" v-if="activeTab && !connected">{{ text.reconnect }}</button>',
    '    </div>',
    '  </header>',
    '  <nav class="diskshell-tabs" role="tablist" :aria-label="text.tabsAriaLabel">',
    '    <div v-for="tab in tabs" :key="tab.id" role="presentation" class="diskshell-tab" :class="{ active: tab.id === activeTabId }">',
    '      <button type="button" role="tab" :aria-selected="tab.id === activeTabId" :tabindex="tab.id === activeTabId ? 0 : -1" @click="switchTab(tab.id)">',
    '        <span class="diskshell-tab-status" :class="tab.connectionState" aria-hidden="true"></span>',
    '        <span>{{ tab.title }}</span>',
    '      </button>',
    `      <button type="button" class="diskshell-tab-close" :aria-label="text.closeTab + ': ' + tab.title" @click.stop="closeTab(tab.id)">×</button>`,
    '    </div>',
    '    <button type="button" class="diskshell-new-tab" :aria-label="text.newTab" :title="text.newTab" :disabled="tabs.length >= 4" @click="addTab">+</button>',
    '  </nav>',
    '  <div v-if="activeTab && activeTab.errorMessage" class="diskshell-alert" role="alert">{{ activeTab.errorMessage }}</div>',
    '  <div ref="terminalHost" class="diskshell-terminal-host">',
    `    <div v-for="tab in tabs" :key="tab.id" ref="terminalCanvases" :data-tab-id="tab.id" v-show="tab.id === activeTabId" class="diskshell-canvas" :aria-label="text.terminalAriaLabel + ': ' + tab.title"></div>`,
    '  </div>',
    '  <terminal-status-bar v-if="activeTab" :state="activeTab.connectionState" :text="text"></terminal-status-bar>',
    '</section>',
  ].join(""),
  data() {
    return {
      text: messages,
      tabs: [] as ShellTab[],
      activeTabId: 0,
      nextTabId: 1,
      clipboardEnabled: false,
      resizeObserver: null as ResizeObserver | null,
      fitFrame: null as number | null,
    };
  },
  computed: {
    activeTab(this: TerminalView): ShellTab | null {
      return this.tabs.find((tab) => tab.id === this.activeTabId) || null;
    },
    connected(this: TerminalView): boolean {
      return this.activeTab?.connectionState === "connected";
    },
  },
  mounted(this: TerminalView): void {
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.$refs.terminalHost);
    this.addTab();
  },
  beforeDestroy(this: TerminalView): void {
    this.resizeObserver?.disconnect();
    if (this.fitFrame !== null) cancelAnimationFrame(this.fitFrame);
    for (const tab of this.tabs) {
      tab.terminalSocket?.disconnect();
      tab.terminal?.dispose();
    }
  },
  methods: {
    addTab(this: TerminalView): void {
      if (this.tabs.length >= maxTabs) return;
      const id = this.nextTabId++;
      this.tabs.push({
        id,
        title: `${this.text.tabTitle} ${id}`,
        connectionState: "connecting",
        errorMessage: "",
        terminal: null,
        fitAddon: null,
        terminalSocket: null,
      });
      this.activeTabId = id;
      this.$nextTick(() => this.initializeTab(id));
    },
    initializeTab(this: TerminalView, tabId: number): void {
      const tab = this.tabs.find((candidate) => candidate.id === tabId);
      const canvases = Array.isArray(this.$refs.terminalCanvases)
        ? this.$refs.terminalCanvases
        : [this.$refs.terminalCanvases];
      const canvas = canvases.find((element) => element.dataset.tabId === String(tabId));
      if (!tab || !canvas || tab.terminal) return;
      tab.terminal = new Terminal({
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
      tab.fitAddon = new FitAddon();
      tab.terminal.loadAddon(tab.fitAddon);
      tab.terminal.open(canvas);
      tab.terminal.onData((data) => tab.terminalSocket?.send({ type: "input", data }));
      tab.terminal.onResize(({ cols, rows }) => tab.terminalSocket?.send({ type: "resize", cols, rows }));
      tab.terminal.attachCustomKeyEventHandler((event) => this.handleClipboardShortcut(tab, event));
      this.connectTab(tab);
    },
    switchTab(this: TerminalView, tabId: number): void {
      if (!this.tabs.some((tab) => tab.id === tabId)) return;
      this.activeTabId = tabId;
      this.$nextTick(() => {
        this.fit();
        this.activeTab?.terminal?.focus();
      });
    },
    closeTab(this: TerminalView, tabId: number): void {
      const index = this.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      const [tab] = this.tabs.splice(index, 1);
      tab.terminalSocket?.disconnect();
      tab.terminal?.dispose();
      if (this.activeTabId === tabId) {
        this.activeTabId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id || 0;
      }
      if (this.tabs.length === 0) this.addTab();
      else this.$nextTick(() => this.scheduleFit());
    },
    connect(this: TerminalView): void {
      if (this.activeTab) this.connectTab(this.activeTab);
    },
    connectTab(this: TerminalView, tab: ShellTab): void {
      tab.terminalSocket?.disconnect();
      tab.connectionState = "connecting";
      tab.errorMessage = "";
      tab.terminal?.clear();
      tab.terminal?.write(`\x1b[38;5;81mDiskShell\x1b[0m – ${this.text.connectingTerminal}\r\n`);
      const terminalSocket = new TerminalSocket({
        onOpen: () => {
          if (tab.terminalSocket !== terminalSocket) return;
          tab.connectionState = "connected";
          tab.errorMessage = "";
          if (tab.id === this.activeTabId) this.fit();
          tab.terminalSocket?.send({
            type: "resize",
            cols: tab.terminal?.cols || 120,
            rows: tab.terminal?.rows || 36,
          });
          if (tab.id === this.activeTabId) tab.terminal?.focus();
        },
        onClose: () => {
          if (tab.terminalSocket !== terminalSocket) return;
          if (tab.connectionState !== "error") tab.connectionState = "disconnected";
        },
        onOutput: (data) => tab.terminal?.write(data),
        onError: (message) => {
          if (tab.terminalSocket !== terminalSocket) return;
          tab.connectionState = "error";
          tab.errorMessage = message;
        },
      });
      tab.terminalSocket = terminalSocket;
      terminalSocket.connect();
    },
    fit(this: TerminalView): void {
      if (!this.activeTab?.fitAddon || !this.activeTab.terminal) return;
      try {
        this.activeTab.fitAddon.fit();
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
    allowClipboard(this: TerminalView): void {
      this.clipboardEnabled = true;
      this.activeTab?.terminal?.focus();
    },
    handleClipboardShortcut(this: TerminalView, tab: ShellTab, event: KeyboardEvent): boolean {
      if (!this.clipboardEnabled || !navigator.clipboard || event.type !== "keydown") return true;
      const clipboardShortcut = event.metaKey || (event.ctrlKey && event.shiftKey);
      if (!clipboardShortcut) return true;
      if (event.key.toLowerCase() === "c" && tab.terminal?.hasSelection()) {
        void navigator.clipboard.writeText(tab.terminal.getSelection());
        return false;
      }
      if (event.key.toLowerCase() === "v") {
        void navigator.clipboard.readText().then((value) => {
          if (value) tab.terminal?.paste(value);
        }).catch(() => undefined);
        return false;
      }
      return true;
    },
  },
};
