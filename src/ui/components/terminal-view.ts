import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";

import {
  listBackgroundSessions,
  renameBackgroundSession,
  TerminalSocket,
  terminateBackgroundSession,
  uploadFiles,
} from "../services/terminal-socket.js";
import { messages } from "../i18n.js";
import { handleSearchShortcutEvent } from "../search-shortcuts.js";
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
  searchAddon: SearchAddon | null;
  searchQuery: string;
  searchResultIndex: number;
  searchResultCount: number;
  terminalSocket: TerminalSocket | null;
};

type TerminalView = {
  text: Messages;
  tabs: ShellTab[];
  activeTabId: number;
  primaryTabId: number;
  secondaryTabId: number;
  splitMode: "none" | "vertical" | "horizontal";
  nextTabId: number;
  clipboardEnabled: boolean;
  backgroundSessions: SessionInfo[];
  sessionsOpen: boolean;
  searchOpen: boolean;
  pendingCloseTab: ShellTab | null;
  notice: string;
  noticeTimer: number | null;
  renamingTabId: number | null;
  renamingSessionId: string;
  renameValue: string;
  resizeObserver: ResizeObserver | null;
  dragDepth: number;
  dragActive: boolean;
  uploading: boolean;
  uploadProgress: number;
  toolbarTooltip: string;
  toolbarTooltipLeft: number;
  toolbarTooltipTop: number;
  fitFrame: number | null;
  searchShortcutHandler: ((event: KeyboardEvent) => void) | null;
  $refs: {
    shell: HTMLElement;
    actions: HTMLElement;
    searchInput?: HTMLInputElement;
    toolbarTooltip?: HTMLElement;
    terminalHost: HTMLElement;
    terminalCanvases: HTMLElement | HTMLElement[];
  };
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
  showToolbarTooltip(event: Event): void;
  hideToolbarTooltip(): void;
  positionToolbarTooltip(button: HTMLButtonElement): void;
  beginTabRename(tab: ShellTab): void;
  beginSessionRename(session: SessionInfo): void;
  commitRename(): Promise<void>;
  cancelRename(): void;
  openSearch(): void;
  handleSearchShortcut(event: KeyboardEvent): boolean;
  closeSearch(): void;
  searchNext(): void;
  searchPrevious(): void;
  enableSplit(mode: "vertical" | "horizontal"): void;
  closeSplit(): void;
  activatePane(tabId: number): void;
  isTabVisible(tabId: number): boolean;
  handleDragEnter(event: DragEvent): void;
  handleDragLeave(): void;
  handleDrop(event: DragEvent): Promise<void>;
  connect(): void;
  fit(): void;
  fitVisible(): void;
  scheduleFit(): void;
};

export const terminalViewComponent = {
  components: { "terminal-status-bar": statusBarComponent },
  template: [
    '<section ref="shell" class="diskshell-shell">',
    '  <header class="diskshell-toolbar">',
    '    <div><strong>DiskShell</strong><span>{{ text.subtitle }}</span></div>',
    '    <div ref="actions" class="diskshell-actions" role="toolbar" :aria-label="text.toolbarLabel" @mouseover="showToolbarTooltip" @focusin="showToolbarTooltip" @mouseleave="hideToolbarTooltip" @focusout="hideToolbarTooltip">',
    '      <div class="diskshell-action-group">',
    '        <button type="button" class="sessions" v-if="backgroundSessions.length" :aria-label="text.sessions" :data-tooltip="text.sessionsTooltip" @click="sessionsOpen = !sessionsOpen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v5H4zM4 14h16v5H4zM7 7.5h.01M7 16.5h.01"/></svg><span class="diskshell-action-badge">{{ backgroundSessions.length }}</span></button>',
    '        <button type="button" v-if="activeTab" :aria-label="text.search" :data-tooltip="text.searchTooltip" @click="openSearch"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg></button>',
    '      </div>',
    '      <div class="diskshell-action-group">',
    '        <button type="button" v-if="splitMode === \'none\'" :aria-disabled="tabs.length < 2" :aria-label="text.splitVertical" :data-tooltip="tabs.length < 2 ? text.splitNeedsTabsTooltip : text.splitVerticalTooltip" @click="enableSplit(\'vertical\')"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg></button>',
    '        <button type="button" v-if="splitMode === \'none\'" :aria-disabled="tabs.length < 2" :aria-label="text.splitHorizontal" :data-tooltip="tabs.length < 2 ? text.splitNeedsTabsTooltip : text.splitHorizontalTooltip" @click="enableSplit(\'horizontal\')"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/></svg></button>',
    '        <button type="button" v-if="splitMode !== \'none\'" :aria-label="text.changeSplit" :data-tooltip="text.changeSplitTooltip" @click="enableSplit(splitMode === \'vertical\' ? \'horizontal\' : \'vertical\')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h11M12 5l3 3-3 3M20 16H9M12 13l-3 3 3 3"/></svg></button>',
    '        <button type="button" v-if="splitMode !== \'none\'" :aria-label="text.closeSplit" :data-tooltip="text.closeSplitTooltip" @click="closeSplit"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m9 9 6 6M15 9l-6 6"/></svg></button>',
    '      </div>',
    '      <div class="diskshell-action-group">',
    '        <button type="button" v-if="activeTab && connected" :class="{ active: activeTab.persistent }" :aria-label="text.keepAlive" :aria-pressed="activeTab.persistent" :data-tooltip="activeTab.persistent ? text.keepAliveEnabledTooltip : text.keepAliveTooltip" @click="togglePersistent"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 8A7.5 7.5 0 1 1 5 15M5.5 8V4M5.5 8H9M12 8v4l3 2"/></svg></button>',
    '        <button type="button" :class="{ active: clipboardEnabled }" :aria-label="clipboardEnabled ? text.clipboardAllowed : text.allowClipboard" :data-tooltip="clipboardEnabled ? text.clipboardAllowedTooltip : text.allowClipboardTooltip" @click="allowClipboard" :disabled="clipboardEnabled"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="13" height="16" rx="2"/><path d="M9 5V3h7v4H9zM3 17V4h3"/></svg></button>',
    '        <button type="button" class="primary" :aria-label="text.reconnect" :data-tooltip="text.reconnectTooltip" @click="connect" v-if="activeTab && !connected && activeTab.processState !== \'exited\'"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M18 12a6 6 0 0 0-10-4L4 12M6 12a6 6 0 0 0 10 4l4-4"/></svg></button>',
    '      </div>',
    '    </div>',
    '  </header>',
    '  <div v-if="toolbarTooltip" ref="toolbarTooltip" class="diskshell-toolbar-tooltip" role="tooltip" :style="{ left: toolbarTooltipLeft + \'px\', top: toolbarTooltipTop + \'px\' }">{{ toolbarTooltip }}</div>',
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
    '  <div ref="terminalHost" class="diskshell-terminal-host" @dragenter.prevent="handleDragEnter" @dragover.prevent @dragleave.prevent="handleDragLeave" @drop.prevent="handleDrop">',
    '    <div v-if="searchOpen && activeTab" class="diskshell-search" role="search">',
    '      <input ref="searchInput" class="diskshell-search-input" v-model="activeTab.searchQuery" :placeholder="text.searchPlaceholder" :aria-label="text.search" @input="searchNext" @keydown.enter.prevent="searchNext">',
    '      <span aria-live="polite">{{ activeTab.searchResultCount ? (activeTab.searchResultIndex + 1) + \' / \' + activeTab.searchResultCount : text.noResults }}</span>',
    '      <button type="button" :aria-label="text.previousResult" :title="text.previousResult" @click="searchPrevious">↑</button>',
    '      <button type="button" :aria-label="text.nextResult" :title="text.nextResult" @click="searchNext">↓</button>',
    '      <button type="button" :aria-label="text.closeSearch" :title="text.closeSearch" @click="closeSearch">×</button>',
    '    </div>',
    '    <div v-if="dragActive || uploading" class="diskshell-upload-overlay" role="status">',
    '      <strong>{{ uploading ? text.uploading : text.dropFiles }}</strong>',
    '      <span v-if="uploading">{{ uploadProgress }}%</span>',
    '      <span v-else>{{ text.uploadLimits }}</span>',
    '    </div>',
    '    <div class="diskshell-panes" :class="\'split-\' + splitMode">',
    `      <div v-for="tab in tabs" :key="tab.id" ref="terminalCanvases" :data-tab-id="tab.id" v-show="isTabVisible(tab.id)" class="diskshell-canvas" :class="{ 'active-pane': tab.id === activeTabId, 'primary-pane': tab.id === primaryTabId, 'secondary-pane': splitMode !== 'none' && tab.id === secondaryTabId }" :aria-label="text.terminalAriaLabel + ': ' + tab.title" @mousedown="activatePane(tab.id)" @focusin="activatePane(tab.id)">`,
    '        <div v-if="splitMode !== \'none\'" class="diskshell-pane-tab" :class="{ active: tab.id === activeTabId }"><span class="diskshell-tab-status" :class="tab.connectionState" aria-hidden="true"></span><strong>{{ tab.title }}</strong></div>',
    '      </div>',
    '    </div>',
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
      primaryTabId: 0,
      secondaryTabId: 0,
      splitMode: "none" as "none" | "vertical" | "horizontal",
      nextTabId: 1,
      clipboardEnabled: false,
      backgroundSessions: [] as SessionInfo[],
      sessionsOpen: false,
      searchOpen: false,
      pendingCloseTab: null as ShellTab | null,
      notice: "",
      noticeTimer: null as number | null,
      renamingTabId: null as number | null,
      renamingSessionId: "",
      renameValue: "",
      resizeObserver: null as ResizeObserver | null,
      fitFrame: null as number | null,
      dragDepth: 0,
      dragActive: false,
      uploading: false,
      uploadProgress: 0,
      toolbarTooltip: "",
      toolbarTooltipLeft: -9999,
      toolbarTooltipTop: -9999,
      searchShortcutHandler: null as ((event: KeyboardEvent) => void) | null,
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
    this.searchShortcutHandler = (event) => { this.handleSearchShortcut(event); };
    window.addEventListener("keydown", this.searchShortcutHandler, true);
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.$refs.terminalHost);
    void this.restoreSessions();
  },
  beforeDestroy(this: TerminalView): void {
    if (this.searchShortcutHandler) window.removeEventListener("keydown", this.searchShortcutHandler, true);
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
      const replaceSecondary = this.splitMode !== "none" && this.activeTabId === this.secondaryTabId;
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
        searchAddon: null,
        searchQuery: "",
        searchResultIndex: -1,
        searchResultCount: 0,
        terminalSocket: null,
      });
      this.activeTabId = id;
      if (this.splitMode === "none") this.primaryTabId = id;
      else if (replaceSecondary) this.secondaryTabId = id;
      else this.primaryTabId = id;
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
      tab.searchAddon = new SearchAddon();
      tab.terminal.loadAddon(tab.fitAddon);
      tab.terminal.loadAddon(tab.searchAddon);
      tab.searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
        tab.searchResultIndex = resultIndex;
        tab.searchResultCount = resultCount;
      });
      tab.terminal.open(canvas);
      tab.terminal.onData((data) => tab.terminalSocket?.send({ type: "input", data }));
      tab.terminal.onResize(({ cols, rows }) => tab.terminalSocket?.send({ type: "resize", cols, rows }));
      tab.terminal.attachCustomKeyEventHandler((event) => this.handleClipboardShortcut(tab, event));
      this.connectTab(tab);
    },
    switchTab(this: TerminalView, tabId: number): void {
      if (!this.tabs.some((tab) => tab.id === tabId)) return;
      if (this.splitMode === "none") {
        this.primaryTabId = tabId;
      } else if (tabId !== this.primaryTabId && tabId !== this.secondaryTabId) {
        if (this.activeTabId === this.secondaryTabId) this.secondaryTabId = tabId;
        else this.primaryTabId = tabId;
      }
      this.activeTabId = tabId;
      this.$nextTick(() => {
        this.fitVisible();
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
      if (this.tabs.length === 0) {
        this.activeTabId = 0;
        this.primaryTabId = 0;
        this.secondaryTabId = 0;
        this.splitMode = "none";
        this.addTab();
        return;
      }
      if (this.splitMode !== "none") {
        if (tab.id === this.primaryTabId) this.primaryTabId = this.secondaryTabId;
        if (tab.id === this.secondaryTabId) this.secondaryTabId = 0;
        if (!this.tabs.some((candidate) => candidate.id === this.primaryTabId)) this.primaryTabId = this.tabs[0].id;
        if (!this.tabs.some((candidate) => candidate.id === this.secondaryTabId) || this.secondaryTabId === this.primaryTabId) {
          this.secondaryTabId = this.tabs.find((candidate) => candidate.id !== this.primaryTabId)?.id || 0;
        }
        if (!this.secondaryTabId) this.splitMode = "none";
      }
      if (this.splitMode === "none") {
        if (this.activeTabId === tab.id) this.activeTabId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id || this.tabs[0].id;
        this.primaryTabId = this.activeTabId;
      } else if (this.activeTabId === tab.id || !this.isTabVisible(this.activeTabId)) {
        this.activeTabId = this.primaryTabId;
      }
      this.$nextTick(() => this.scheduleFit());
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
            if (this.isTabVisible(tab.id)) this.fitVisible();
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
    fitVisible(this: TerminalView): void {
      for (const tab of this.tabs) {
        if (!this.isTabVisible(tab.id) || !tab.fitAddon || !tab.terminal) continue;
        try {
          tab.fitAddon.fit();
        } catch {
          // DSM can briefly report a zero-sized pane during layout changes.
        }
      }
    },
    scheduleFit(this: TerminalView): void {
      if (this.fitFrame !== null) cancelAnimationFrame(this.fitFrame);
      this.fitFrame = requestAnimationFrame(() => {
        this.fitFrame = null;
        if (this.splitMode !== "none" && this.$refs.terminalHost.clientWidth < 620) {
          this.closeSplit();
          return;
        }
        this.fitVisible();
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
    showToolbarTooltip(this: TerminalView, event: Event): void {
      const element = event.target instanceof Element ? event.target : null;
      const button = element?.closest<HTMLButtonElement>("button[data-tooltip]");
      if (!button || !this.$refs.actions.contains(button)) return;
      const tooltip = button.dataset.tooltip || "";
      if (!tooltip) return;
      this.toolbarTooltip = tooltip;
      this.toolbarTooltipLeft = -9999;
      this.toolbarTooltipTop = -9999;
      this.$nextTick(() => this.positionToolbarTooltip(button));
    },
    hideToolbarTooltip(this: TerminalView): void {
      this.toolbarTooltip = "";
    },
    positionToolbarTooltip(this: TerminalView, button: HTMLButtonElement): void {
      const tooltip = this.$refs.toolbarTooltip;
      if (!tooltip || !button.isConnected) return;
      const shellBounds = this.$refs.shell.getBoundingClientRect();
      const buttonBounds = button.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(tooltip.offsetWidth, shellBounds.width - margin * 2);
      const centered = buttonBounds.left - shellBounds.left + buttonBounds.width / 2 - width / 2;
      this.toolbarTooltipLeft = Math.max(margin, Math.min(centered, shellBounds.width - width - margin));
      const below = buttonBounds.bottom - shellBounds.top + margin;
      const above = buttonBounds.top - shellBounds.top - tooltip.offsetHeight - margin;
      this.toolbarTooltipTop = below + tooltip.offsetHeight <= shellBounds.height - margin ? below : Math.max(margin, above);
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
    openSearch(this: TerminalView): void {
      this.searchOpen = true;
      this.$nextTick(() => this.$refs.searchInput?.select());
    },
    handleSearchShortcut(this: TerminalView, event: KeyboardEvent): boolean {
      return handleSearchShortcutEvent({
        searchOpen: this.searchOpen,
        targetIsInside: event.target instanceof Node && this.$refs.shell.contains(event.target),
        openSearch: () => this.openSearch(),
        closeSearch: () => this.closeSearch(),
      }, event);
    },
    closeSearch(this: TerminalView): void {
      this.searchOpen = false;
      this.activeTab?.searchAddon?.clearDecorations();
      this.activeTab?.terminal?.focus();
    },
    searchNext(this: TerminalView): void {
      const tab = this.activeTab;
      if (!tab?.searchAddon) return;
      if (!tab.searchQuery) {
        tab.searchAddon.clearDecorations();
        tab.searchResultIndex = -1;
        tab.searchResultCount = 0;
        return;
      }
      tab.searchAddon.findNext(tab.searchQuery, {
        incremental: true,
        decorations: {
          matchBackground: "#35546f",
          matchOverviewRuler: "#61dafb",
          activeMatchBackground: "#b286ff",
          activeMatchColorOverviewRuler: "#b286ff",
        },
      });
    },
    searchPrevious(this: TerminalView): void {
      const tab = this.activeTab;
      if (!tab?.searchAddon || !tab.searchQuery) return;
      tab.searchAddon.findPrevious(tab.searchQuery, {
        decorations: {
          matchBackground: "#35546f",
          matchOverviewRuler: "#61dafb",
          activeMatchBackground: "#b286ff",
          activeMatchColorOverviewRuler: "#b286ff",
        },
      });
    },
    enableSplit(this: TerminalView, mode: "vertical" | "horizontal"): void {
      if (this.tabs.length < 2) return;
      if (this.$refs.terminalHost.clientWidth < 620) {
        this.showNotice(this.text.splitNeedsSpace);
        return;
      }
      if (this.splitMode === "none") {
        const companion = this.tabs.find((tab) => tab.id !== this.activeTabId);
        const orderedTabs = this.tabs.filter((tab) => tab.id === this.activeTabId || tab.id === companion?.id);
        this.primaryTabId = orderedTabs[0]?.id || this.activeTabId;
        this.secondaryTabId = orderedTabs[1]?.id || 0;
      }
      this.splitMode = mode;
      this.$nextTick(() => this.fitVisible());
    },
    closeSplit(this: TerminalView): void {
      this.splitMode = "none";
      this.primaryTabId = this.activeTabId;
      this.secondaryTabId = 0;
      this.$nextTick(() => this.fitVisible());
    },
    activatePane(this: TerminalView, tabId: number): void {
      if (!this.isTabVisible(tabId)) return;
      this.activeTabId = tabId;
      const tab = this.tabs.find((candidate) => candidate.id === tabId);
      this.$nextTick(() => tab?.terminal?.focus());
    },
    isTabVisible(this: TerminalView, tabId: number): boolean {
      return tabId === this.primaryTabId || (this.splitMode !== "none" && tabId === this.secondaryTabId);
    },
    handleDragEnter(this: TerminalView, event: DragEvent): void {
      if (!event.dataTransfer?.types.includes("Files")) return;
      this.dragDepth += 1;
      this.dragActive = true;
    },
    handleDragLeave(this: TerminalView): void {
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.dragActive = false;
    },
    async handleDrop(this: TerminalView, event: DragEvent): Promise<void> {
      this.dragDepth = 0;
      this.dragActive = false;
      const tab = this.activeTab;
      const files = Array.from(event.dataTransfer?.files || []);
      if (!tab || tab.connectionState !== "connected" || files.length === 0) return;
      if (files.length > 10 || files.some((file) => file.size > 25 * 1024 * 1024)) {
        this.showNotice(this.text.uploadLimits);
        return;
      }
      this.uploading = true;
      this.uploadProgress = 0;
      try {
        const uploads = await uploadFiles(files, (percent) => { this.uploadProgress = percent; });
        const paths = uploads.map((upload) => shellQuote(upload.path)).join(" ");
        tab.terminal?.paste(paths);
        this.showNotice(this.text.uploadComplete.replace("{count}", String(uploads.length)));
      } catch {
        this.showNotice(this.text.uploadFailed);
      } finally {
        this.uploading = false;
        this.uploadProgress = 0;
        tab.terminal?.focus();
      }
    },
    allowClipboard(this: TerminalView): void {
      this.clipboardEnabled = true;
      this.activeTab?.terminal?.focus();
    },
    handleClipboardShortcut(this: TerminalView, tab: ShellTab, event: KeyboardEvent): boolean {
      if (this.handleSearchShortcut(event)) return false;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
