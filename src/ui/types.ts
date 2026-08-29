export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type ServerMessage =
  | { type: "output"; data: string }
  | { type: "error"; message: string };
