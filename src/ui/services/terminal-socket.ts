import type { ClientMessage, ServerMessage } from "../types.js";
import { messages } from "../i18n.js";

export interface TerminalSocketEvents {
  onOpen(): void;
  onClose(): void;
  onOutput(data: string): void;
  onError(message: string): void;
}

export class TerminalSocket {
  private socket: WebSocket | null = null;

  constructor(private readonly events: TerminalSocketEvents) {}

  connect(): void {
    this.disconnect();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = currentSynoToken();
    const query = token ? `?SynoToken=${encodeURIComponent(token)}` : "";
    const socket = new WebSocket(`${protocol}//${window.location.host}/diskshell/ws${query}`);
    this.socket = socket;
    socket.addEventListener("open", () => this.events.onOpen());
    socket.addEventListener("close", () => this.events.onClose());
    socket.addEventListener("error", () => this.events.onError(messages.connectionFailed));
    socket.addEventListener("message", (event) => this.receive(event.data));
  }

  disconnect(): void {
    this.socket?.close(1000, "Terminal window closed");
    this.socket = null;
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private receive(value: unknown): void {
    if (typeof value !== "string") return;
    try {
      const message = JSON.parse(value) as ServerMessage;
      if (message.type === "output" && typeof message.data === "string") this.events.onOutput(message.data);
      if (message.type === "error") {
        if (message.code === "shell_start_failed") this.events.onError(messages.shellStartFailed);
        else this.events.onError(typeof message.message === "string" ? message.message : messages.serviceError);
      }
    } catch {
      this.events.onError(messages.invalidResponse);
    }
  }
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
