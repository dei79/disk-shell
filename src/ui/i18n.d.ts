import type { ConnectionState } from "./types.js";

export type Messages = {
  subtitle: string;
  allowClipboard: string;
  clipboardAllowed: string;
  reconnect: string;
  newTab: string;
  closeTab: string;
  tabsAriaLabel: string;
  tabTitle: string;
  terminalAriaLabel: string;
  connectingTerminal: string;
  connectionFailed: string;
  invalidResponse: string;
  shellStartFailed: string;
  serviceError: string;
  sessionHint: string;
  status: Record<ConnectionState, string>;
};

export function selectMessages(language: unknown): Messages;
export function currentDSMLanguage(): string;
export const messages: Messages;
