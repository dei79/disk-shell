import type { ClientMessage, ServerMessage, SessionInfo } from "../types.js";
import { messages } from "../i18n.js";

export interface TerminalSocketEvents {
  onOpen(): void;
  onClose(): void;
  onOutput(data: string): void;
  onSession(session: SessionInfo): void;
  onError(message: string): void;
}

export interface TerminalSocketOptions {
  sessionId?: string;
  name: string;
}

export class TerminalSocket {
  private socket: WebSocket | null = null;
  private ready = false;

  constructor(
    private readonly options: TerminalSocketOptions,
    private readonly events: TerminalSocketEvents,
  ) {}

  connect(): void {
    this.disconnect();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = currentSynoToken();
    const protocols = token ? [synoTokenSubprotocol(token)] : undefined;
    const socket = new WebSocket(`${protocol}//${window.location.host}/diskshell/ws`, protocols);
    this.socket = socket;
    this.ready = false;
    socket.addEventListener("open", () => {
      this.send({ type: "open", sessionId: this.options.sessionId, name: this.options.name });
    });
    socket.addEventListener("close", () => this.events.onClose());
    socket.addEventListener("error", () => this.events.onError(messages.connectionFailed));
    socket.addEventListener("message", (event) => this.receive(event.data));
  }

  disconnect(): void {
    this.socket?.close(1000, "Terminal window closed");
    this.socket = null;
    this.ready = false;
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private receive(value: unknown): void {
    if (typeof value !== "string") return;
    try {
      const message = JSON.parse(value) as ServerMessage;
      if (message.type === "output" && typeof message.data === "string") this.events.onOutput(message.data);
      if (message.type === "session" && message.session) {
        this.events.onSession(message.session);
        if (!this.ready) {
          this.ready = true;
          this.events.onOpen();
        }
      }
      if (message.type === "error") {
        if (message.code === "shell_start_failed") this.events.onError(messages.shellStartFailed);
        else this.events.onError(typeof message.message === "string" ? message.message : messages.serviceError);
      }
    } catch {
      this.events.onError(messages.invalidResponse);
    }
  }
}

export async function listBackgroundSessions(): Promise<SessionInfo[]> {
  const response = await sessionFetch("/diskshell/sessions", { method: "GET" });
  if (!response.ok) throw new Error(messages.connectionFailed);
  const message = await response.json() as ServerMessage;
  return message.type === "sessions" && Array.isArray(message.sessions) ? message.sessions : [];
}

export async function terminateBackgroundSession(sessionId: string): Promise<void> {
  const response = await sessionFetch(`/diskshell/sessions?id=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(messages.serviceError);
}

export async function renameBackgroundSession(sessionId: string, name: string): Promise<SessionInfo> {
  const response = await sessionFetch(`/diskshell/sessions?id=${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(messages.renameFailed);
  const message = await response.json() as ServerMessage;
  if (message.type !== "session" || !message.session) throw new Error(messages.invalidResponse);
  return message.session;
}

function sessionFetch(path: string, init: RequestInit): Promise<Response> {
  const token = currentSynoToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("X-Syno-Token", token);
  return fetch(path, { ...init, credentials: "same-origin", headers });
}

function synoTokenSubprotocol(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `diskshell.syno-token.${encoded}`;
}

function currentSynoToken(): string {
  const scripts = Array.from(document.scripts);
  const source = document.currentScript?.getAttribute("src")
    || scripts.reverse().find((script) => script.src.includes("DiskShell-"))?.src
    || "";
  if (!source) return "";
  try {
    return new URL(source, window.location.href).searchParams.get("SynoToken") || "";
  } catch {
    return "";
  }
}
