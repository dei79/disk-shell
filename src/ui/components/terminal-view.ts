import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import {
  listBackgroundSessions,
  renameBackgroundSession,
  TerminalSocket,
  terminateBackgroundSession,
} from "../services/terminal-socket.js";
import { messages } from "../i18n.js";
import type { Messages } from "../i18n.js";
import type { ConnectionState, SessionInfo } from "../types.js";
import { statusBarComponent } from "./status-bar.js";

const maxTabs = 4;

type ShellTab = {
  id: number;
  sessionId: string;
  title: string;
  persistent: boolean;
  processState: "running" | "exited";
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
  backgroundSessions: SessionInfo[];
  sessionsOpen: boolean;
  pendingCloseTab: ShellTab | null;
  notice: string;
  noticeTimer: number | null;
  renamingTabId: number | null;
  renamingSessionId: string;
  renameValue: string;
  resizeObserver: ResizeObserver | null;
  fitFrame: number | null;
  $refs: { terminalHost: HTMLElement; terminalCanvases: HTMLElement | HTMLElement[] };
  $nextTick(callback: () => void): void;
  activeTab: ShellTab | null;
  restoreSessions(): Promise<void>;
  addTab(session?: SessionInfo): void;
  switchTab(tabId: number): void;
  initializeTab(tabId: number): void;
  connectTab(tab: ShellTab): void;
  handleClipboardShortcut(tab: ShellTab, event: KeyboardEvent): boolean;
  removeTab(tab: ShellTab): void;
  refreshSessions(): Promise<void>;
  showNotice(message: string): void;
  beginTabRename(tab: ShellTab): void;
  beginSessionRename(session: SessionInfo): void;
  commitRename(): Promise<void>;
  cancelRename(): void;
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
    '      <button type="button" class="sessions" v-if="backgroundSessions.length" @click="sessionsOpen = !sessionsOpen">{{ text.sessions }} · {{ backgroundSessions.length }}</button>',
    '      <button type="button" v-if="activeTab && connected" @click="togglePersistent">{{ activeTab.persistent ? text.keepAliveEnabled : text.keepAlive }}</button>',
    '      <button type="button" @click="allowClipboard" :disabled="clipboardEnabled">{{ clipboardEnabled ? text.clipboardAllowed : text.allowClipboard }}</button>',
    '      <button type="button" class="primary" @click="connect" v-if="activeTab && !connected && activeTab.processState !== \'exited\'">{{ text.reconnect }}</button>',
    '    </div>',
    '  </header>',
    '  <nav class="diskshell-tabs" role="tablist" :aria-label="text.tabsAriaLabel">',
    '    <div v-for="tab in tabs" :key="tab.id" role="presentation" class="diskshell-tab" :class="{ active: tab.id === activeTabId, persistent: tab.persistent }">',
    '      <button v-if="renamingTabId !== tab.id" type="button" role="tab" :aria-selected="tab.id === activeTabId" :tabindex="tab.id === activeTabId ? 0 : -1" @click="switchTab(tab.id)" @dblclick="beginTabRename(tab)">',
    '        <span class="diskshell-tab-status" :class="tab.connectionState" aria-hidden="true"></span>',
    '        <span class="diskshell-tab-pin" v-if="tab.persistent" :title="text.keepAliveEnabled" aria-hidden="true">◆</span>',
    '        <span>{{ tab.title }}</span>',
    '      </button>',
    '      <input v-else class="diskshell-rename-input" v-model="renameValue" :aria-label="text.renameSession" maxlength="64" @keydown.enter.prevent="commitRename" @keydown.esc.prevent="cancelRename" @blur="commitRename">',
    '      <button type="button" class="diskshell-tab-rename" :aria-label="text.renameSession + \': \' + tab.title" :title="text.renameSession" @click.stop="beginTabRename(tab)">✎</button>',
    `      <button type="button" class="diskshell-tab-close" :aria-label="text.closeTab + ': ' + tab.title" @click.stop="requestCloseTab(tab)">×</button>`,
    '    </div>',
    '    <button type="button" class="diskshell-new-tab" :aria-label="text.newTab" :title="text.newTab" :disabled="tabs.length >= 4" @click="addTab()">+</button>',
    '  </nav>',
    '  <aside v-if="sessionsOpen" class="diskshell-session-panel" :aria-label="text.sessions">',
    '    <header><strong>{{ text.backgroundSessions }}</strong><button type="button" @click="sessionsOpen = false">×</button></header>',
    '    <div v-for="session in backgroundSessions" :key="session.id" class="diskshell-session-item">',
    '      <div><strong v-if="renamingSessionId !== session.id">{{ session.name }}</strong><input v-else class="diskshell-rename-input" v-model="renameValue" :aria-label="text.renameSession" maxlength="64" @keydown.enter.prevent="commitRename" @keydown.esc.prevent="cancelRename" @blur="commitRename"><span>{{ session.attached ? text.activeElsewhere : (session.state === \'running\' ? text.running : text.exited) }}</span></div>',
    '      <button type="button" :aria-label="text.renameSession + \': \' + session.name" :title="text.renameSession" @click="beginSessionRename(session)">✎</button>',
    '      <button type="button" @click="openBackgroundSession(session)">{{ session.attached ? text.takeOver : text.openSession }}</button>',
    '      <button type="button" class="danger" @click="endBackgroundSession(session)">{{ text.endSession }}</button>',
    '    </div>',
    '  </aside>',
    '  <div v-if="activeTab && activeTab.errorMessage" class="diskshell-alert" role="alert">{{ activeTab.errorMessage }}</div>',
    '  <div ref="terminalHost" class="diskshell-terminal-host">',
    `    <div v-for="tab in tabs" :key="tab.id" ref="terminalCanvases" :data-tab-id="tab.id" v-show="tab.id === activeTabId" class="diskshell-canvas" :aria-label="text.terminalAriaLabel + ': ' + tab.title"></div>`,
    '  </div>',
    '  <terminal-status-bar v-if="activeTab" :state="activeTab.connectionState" :text="text"></terminal-status-bar>',
    '  <div v-if="notice" class="diskshell-notice" role="status">{{ notice }}</div>',
    '  <div v-if="pendingCloseTab" class="diskshell-dialog-backdrop" @click.self="pendingCloseTab = null">',
    '    <div class="diskshell-dialog" role="dialog" aria-modal="true" :aria-label="text.closeBackgroundTitle">',
    '      <strong>{{ text.closeBackgroundTitle }}</strong>',
    '      <p>{{ text.closeBackgroundDescription }}</p>',
    '      <div>',
    '        <button type="button" class="primary" @click="hidePendingTab">{{ text.hideTab }}</button>',
    '        <button type="button" class="danger" @click="endPendingTab">{{ text.endSession }}</button>',
    '        <button type="button" @click="pendingCloseTab = null">{{ text.cancel }}</button>',
    '      </div>',
    '    </div>',
    '  </div>',
    '</section>',
  ].join(""),
  data() {
    return {
      text: messages,
      tabs: [] as ShellTab[],
      activeTabId: 0,
      nextTabId: 1,
      clipboardEnabled: false,
      backgroundSessions: [] as SessionInfo[],
      sessionsOpen: false,
      pendingCloseTab: null as ShellTab | null,
      notice: "",
      noticeTimer: null as number | null,
      renamingTabId: null as number | null,
      renamingSessionId: "",
      renameValue: "",
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
    void this.restoreSessions();
  },
  beforeDestroy(this: TerminalView): void {
    this.resizeObserver?.disconnect();
    if (this.fitFrame !== null) cancelAnimationFrame(this.fitFrame);
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    for (const tab of this.tabs) {
      tab.terminalSocket?.disconnect();
      tab.terminal?.dispose();
    }
  },
  methods: {
    async restoreSessions(this: TerminalView): Promise<void> {
      await this.refreshSessions();
      const running = this.backgroundSessions
        .filter((session) => session.state === "running" && !session.attached)
        .slice(0, maxTabs);
      if (running.length) {
        for (const session of running.reverse()) this.addTab(session);
      } else {
        this.addTab();
      }
    },
    async refreshSessions(this: TerminalView): Promise<void> {
      try {
        this.backgroundSessions = await listBackgroundSessions();
      } catch {
        this.backgroundSessions = [];
      }
    },
    addTab(this: TerminalView, session?: SessionInfo): void {
      const existing = session && this.tabs.find((tab) => tab.sessionId === session.id);
      if (existing) {
        this.switchTab(existing.id);
        return;
      }
      if (this.tabs.length >= maxTabs) return;
      const id = this.nextTabId++;
      this.tabs.push({
        id,
        sessionId: session?.id || "",
        title: session?.name || `${this.text.tabTitle} ${id}`,
        persistent: session?.persistent || false,
        processState: session?.state || "running",
        connectionState: "connecting",
        errorMessage: "",
        terminal: null,
        fitAddon: null,
        terminalSocket: null,
      });
      this.activeTabId = id;
      this.sessionsOpen = false;
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
    requestCloseTab(this: TerminalView, tab: ShellTab): void {
      if (tab.persistent) this.pendingCloseTab = tab;
      else this.removeTab(tab);
    },
    hidePendingTab(this: TerminalView): void {
      const tab = this.pendingCloseTab;
      this.pendingCloseTab = null;
      if (!tab) return;
      this.removeTab(tab);
      this.showNotice(this.text.sessionContinues);
      void this.refreshSessions();
    },
    endPendingTab(this: TerminalView): void {
      const tab = this.pendingCloseTab;
      this.pendingCloseTab = null;
      if (!tab) return;
      tab.terminalSocket?.send({ type: "terminate" });
      this.removeTab(tab);
      window.setTimeout(() => void this.refreshSessions(), 250);
    },
    removeTab(this: TerminalView, tab: ShellTab): void {
      const index = this.tabs.indexOf(tab);
      if (index < 0) return;
      this.tabs.splice(index, 1);
      tab.terminalSocket?.disconnect();
      tab.terminal?.dispose();
      if (this.activeTabId === tab.id) {
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
      const terminalSocket = new TerminalSocket(
        { sessionId: tab.sessionId || undefined, name: tab.title },
        {
          onSession: (session) => {
            if (tab.terminalSocket !== terminalSocket) return;
            const changed = tab.persistent !== session.persistent;
            tab.sessionId = session.id;
            tab.title = session.name;
            tab.persistent = session.persistent;
            tab.processState = session.state;
            if (changed) {
              this.showNotice(session.persistent ? this.text.sessionPinned : this.text.sessionUnpinned);
              void this.refreshSessions();
            }
          },
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
          onOutput: (data) => {
            if (tab.terminalSocket === terminalSocket) tab.terminal?.write(data);
          },
          onError: (message) => {
            if (tab.terminalSocket !== terminalSocket) return;
            tab.connectionState = "error";
            tab.errorMessage = message;
          },
        },
      );
      tab.terminalSocket = terminalSocket;
      terminalSocket.connect();
    },
    togglePersistent(this: TerminalView): void {
      const tab = this.activeTab;
      if (tab) tab.terminalSocket?.send({ type: "persist", persistent: !tab.persistent });
    },
    openBackgroundSession(this: TerminalView, session: SessionInfo): void {
      this.addTab(session);
    },
    async endBackgroundSession(this: TerminalView, session: SessionInfo): Promise<void> {
      const openTab = this.tabs.find((tab) => tab.sessionId === session.id);
      if (openTab) {
        openTab.terminalSocket?.send({ type: "terminate" });
        this.removeTab(openTab);
      } else {
        await terminateBackgroundSession(session.id);
      }
      await this.refreshSessions();
      if (!this.backgroundSessions.length) this.sessionsOpen = false;
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
    showNotice(this: TerminalView, message: string): void {
      this.notice = message;
      if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
      this.noticeTimer = window.setTimeout(() => {
        this.notice = "";
        this.noticeTimer = null;
      }, 3500);
    },
    beginTabRename(this: TerminalView, tab: ShellTab): void {
      this.renamingSessionId = "";
      this.renamingTabId = tab.id;
      this.renameValue = tab.title;
      this.$nextTick(() => document.querySelector<HTMLInputElement>(".diskshell-rename-input")?.select());
    },
    beginSessionRename(this: TerminalView, session: SessionInfo): void {
      this.renamingTabId = null;
      this.renamingSessionId = session.id;
      this.renameValue = session.name;
      this.$nextTick(() => document.querySelector<HTMLInputElement>(".diskshell-session-panel .diskshell-rename-input")?.select());
    },
    async commitRename(this: TerminalView): Promise<void> {
      const tabId = this.renamingTabId;
      const sessionId = this.renamingSessionId;
      const name = this.renameValue.trim();
      this.cancelRename();
      if (!name || name.length > 64) {
        this.showNotice(this.text.invalidSessionName);
        return;
      }
      if (tabId !== null) {
        const tab = this.tabs.find((candidate) => candidate.id === tabId);
        if (!tab || tab.title === name) return;
        tab.title = name;
        tab.terminalSocket?.send({ type: "rename", name });
        void this.refreshSessions();
        return;
      }
      if (!sessionId) return;
      try {
        const renamed = await renameBackgroundSession(sessionId, name);
        const session = this.backgroundSessions.find((candidate) => candidate.id === sessionId);
        if (session) session.name = renamed.name;
        const tab = this.tabs.find((candidate) => candidate.sessionId === sessionId);
        if (tab) tab.title = renamed.name;
      } catch {
        this.showNotice(this.text.renameFailed);
      }
    },
    cancelRename(this: TerminalView): void {
      this.renamingTabId = null;
      this.renamingSessionId = "";
      this.renameValue = "";
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
        void navigator.clipboard.writeText(tab.terminal.getSelection()).catch(() => undefined);
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
