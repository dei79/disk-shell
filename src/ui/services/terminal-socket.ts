import type { ClientMessage, ServerMessage, SessionInfo, UploadInfo } from "../types.js";
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

export type UploadCollision = "ask" | "override" | "keep-both";

export class UploadConflictError extends Error {
  constructor(public readonly remainingFiles: File[] = []) {
    super(messages.uploadFailed);
  }
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

export async function checkUploadConflicts(files: File[], sessionId: string): Promise<{ conflict: boolean; target: string }> {
  const response = await sessionFetch("/diskshell/uploads/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, names: files.map((file) => file.name) }),
  });
  if (!response.ok) throw new Error(messages.uploadFailed);
  const message = await response.json() as { conflict: boolean; target: string };
  if (typeof message.conflict !== "boolean" || typeof message.target !== "string") throw new Error(messages.invalidResponse);
  return message;
}

export async function uploadFiles(
  files: File[],
  sessionId: string,
  collision: UploadCollision,
  target: string,
  onProgress: (percent: number) => void,
): Promise<UploadInfo[]> {
  const uploads: UploadInfo[] = [];
  const totalBytes = Math.max(1, files.reduce((total, file) => total + file.size, 0));
  let completedBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    try {
      const upload = await uploadFile(file, sessionId, collision, target, (loaded) => {
        onProgress(Math.round(((completedBytes + loaded) / totalBytes) * 100));
      });
      uploads.push(upload);
      completedBytes += file.size;
      onProgress(Math.round((completedBytes / totalBytes) * 100));
    } catch (error) {
      if (error instanceof UploadConflictError) throw new UploadConflictError(files.slice(index));
      throw error;
    }
  }
  return uploads;
}

function uploadFile(
  file: File,
  sessionId: string,
  collision: UploadCollision,
  target: string,
  onProgress: (loaded: number) => void,
): Promise<UploadInfo> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const query = new URLSearchParams({ sessionId, collision });
    request.open("POST", `/diskshell/uploads?${query.toString()}`);
    request.withCredentials = true;
    request.setRequestHeader("X-Upload-Target", target);
    const token = currentSynoToken();
    if (token) request.setRequestHeader("X-Syno-Token", token);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.min(file.size, event.loaded));
    });
    request.addEventListener("load", () => {
      if (request.status < 200 || request.status >= 300) {
        reject(request.status === 409 ? new UploadConflictError() : new Error(messages.uploadFailed));
        return;
      }
      try {
        const response = JSON.parse(request.responseText) as { uploads?: UploadInfo[] };
        if (!Array.isArray(response.uploads) || response.uploads.length !== 1) throw new Error(messages.invalidResponse);
        resolve(response.uploads[0]);
      } catch {
        reject(new Error(messages.invalidResponse));
      }
    });
    request.addEventListener("error", () => reject(new Error(messages.uploadFailed)));
    request.addEventListener("abort", () => reject(new Error(messages.uploadFailed)));
    const body = new FormData();
    body.append("files", file, file.name);
    request.send(body);
  });
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
