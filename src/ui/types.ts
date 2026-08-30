export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

export type ClientMessage =
  | { type: "open"; sessionId?: string; name?: string }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "persist"; persistent: boolean }
  | { type: "rename"; name: string }
  | { type: "terminate" };

export type SessionInfo = {
  id: string;
  name: string;
  state: "running" | "exited";
  persistent: boolean;
  attached: boolean;
  lastActivity: string;
};

export type ServerMessage =
  | { type: "output"; data: string }
  | { type: "session"; session: SessionInfo }
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "error"; code?: string; message?: string };
