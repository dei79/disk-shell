const english = Object.freeze({
  subtitle: "Interactive shell on your NAS",
  copy: "Copy",
  paste: "Paste",
  reconnect: "Reconnect",
  terminalAriaLabel: "Interactive DiskShell terminal",
  connectingTerminal: "Connecting …",
  connectionFailed: "The terminal connection could not be established.",
  invalidResponse: "The terminal service returned an invalid response.",
  shellStartFailed: "The DSM shell could not be started.",
  serviceError: "The terminal service returned an error.",
  sessionHint: "DSM administrator account · authenticated by the current DSM session",
  status: Object.freeze({
    connecting: "Connecting …",
    connected: "Connected",
    disconnected: "Disconnected",
    error: "Connection error",
  }),
});

const german = Object.freeze({
  subtitle: "Interaktive Shell auf deinem NAS",
  copy: "Kopieren",
  paste: "Einfügen",
  reconnect: "Neu verbinden",
  terminalAriaLabel: "Interaktives DiskShell-Terminal",
  connectingTerminal: "Verbindung wird hergestellt …",
  connectionFailed: "Die Terminal-Verbindung konnte nicht hergestellt werden.",
  invalidResponse: "Der Terminal-Dienst hat eine ungültige Antwort gesendet.",
  shellStartFailed: "Die DSM-Shell konnte nicht gestartet werden.",
  serviceError: "Der Terminal-Dienst hat einen Fehler gemeldet.",
  sessionHint: "DSM-Administratorkonto · über die aktuelle DSM-Sitzung authentifiziert",
  status: Object.freeze({
    connecting: "Verbindung wird hergestellt …",
    connected: "Verbunden",
    disconnected: "Verbindung beendet",
    error: "Verbindungsfehler",
  }),
});

export function selectMessages(language) {
  return String(language || "").toLowerCase() === "ger" ? german : english;
}

export function currentDSMLanguage() {
  try {
    return window.SYNO?.SDS?.Session?.lang || "";
  } catch {
    return "";
  }
}

export const messages = selectMessages(currentDSMLanguage());
