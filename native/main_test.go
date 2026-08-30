package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestAllowedOrigin(t *testing.T) {
	request := httptest.NewRequest("GET", "http://dsm.local/diskshell/ws", nil)
	request.Host = "dsm.local"
	request.Header.Set("Origin", "https://dsm.local")
	if !allowedOrigin(request) {
		t.Fatal("same-host DSM origin must be accepted")
	}
	request.Header.Set("Origin", "https://attacker.example")
	if allowedOrigin(request) {
		t.Fatal("cross-origin websocket must be rejected")
	}
}

func TestSynoTokenFromSubprotocol(t *testing.T) {
	request := httptest.NewRequest("GET", "http://dsm.local/diskshell/ws", nil)
	request.Header.Set("Sec-WebSocket-Protocol", "diskshell.syno-token.c2FmZS10b2tlbg")
	token, protocol, err := synoTokenFromSubprotocol(request)
	if err != nil || token != "safe-token" || protocol != "diskshell.syno-token.c2FmZS10b2tlbg" {
		t.Fatalf("unexpected SynoToken result %q with protocol %q: %v", token, protocol, err)
	}
	request.Header.Set("Sec-WebSocket-Protocol", "diskshell.syno-token.invalid!")
	if _, _, err := synoTokenFromSubprotocol(request); err == nil {
		t.Fatal("invalid SynoToken encoding was accepted")
	}
}

func TestDimensions(t *testing.T) {
	if !validDimensions(120, 36) || validDimensions(0, 0) || validDimensions(401, 36) {
		t.Fatal("terminal dimensions were not bounded")
	}
}

func TestCGIEnvironment(t *testing.T) {
	request := httptest.NewRequest("GET", "http://dsm.local/diskshell/ws?SynoToken=safe-token", nil)
	request.Host = "dsm.local"
	request.RemoteAddr = "192.0.2.3:40000"
	request.Header.Set("Cookie", "id=abc")
	values := cgiEnvironment(request)
	wanted := map[string]bool{
		"PATH=/usr/syno/bin:/usr/bin:/bin":  false,
		"QUERY_STRING=SynoToken=safe-token": false,
		"HTTP_COOKIE=id=abc":                false,
		"REMOTE_ADDR=192.0.2.3":             false,
	}
	for _, value := range values {
		if _, ok := wanted[value]; ok {
			wanted[value] = true
		}
	}
	for value, present := range wanted {
		if !present {
			t.Fatalf("missing CGI environment value %q", value)
		}
	}
	for _, value := range values {
		if strings.HasPrefix(value, "DISKSHELL_") {
			t.Fatalf("inherited service environment leaked into CGI: %q", value)
		}
	}
}

func TestDevelopmentOverridesRequireMatchingRealAndEffectiveIdentity(t *testing.T) {
	// This test documents the setuid boundary. The package binary has differing
	// real/effective IDs on DSM, so the override condition must remain explicit.
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(source), `os.Getuid() == os.Geteuid() && os.Getenv("DISKSHELL_DEVELOPMENT") == "1"`) {
		t.Fatal("development overrides are not guarded against setuid execution")
	}
}

func TestParseGroupIDs(t *testing.T) {
	groups, err := parseGroupIDs("100 101 65536\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 3 || groups[0] != 100 || groups[1] != 101 || groups[2] != 65536 {
		t.Fatalf("unexpected group IDs: %v", groups)
	}
	if _, err := parseGroupIDs("100 invalid"); err == nil {
		t.Fatal("invalid group output must be rejected")
	}
}

func TestShellHomeFallsBackForMissingDirectory(t *testing.T) {
	directory := t.TempDir()
	if home := shellHome(directory); home != directory {
		t.Fatalf("existing home directory changed to %q", home)
	}
	if home := shellHome(directory + "/missing"); home != "/tmp" {
		t.Fatalf("missing home directory did not fall back: %q", home)
	}
}

func TestTerminalRejectsInvalidSession(t *testing.T) {
	authenticateCGI := writeTestExecutable(t, "authenticate.cgi", "#!/bin/sh\nexit 0\n")
	idBinary := writeTestExecutable(t, "id", "#!/bin/sh\nexit 1\n")
	configureDevelopmentAuthentication(t, authenticateCGI, idBinary)

	request := httptest.NewRequest("GET", "http://dsm.local/diskshell/ws", nil)
	request.Host = "dsm.local"
	request.Header.Set("Origin", "http://dsm.local")
	response := httptest.NewRecorder()
	terminal(response, request)
	if response.Code != 401 {
		t.Fatalf("invalid session returned HTTP %d", response.Code)
	}
}

func TestTerminalRejectsNonAdministrator(t *testing.T) {
	if _, err := user.Current(); err != nil {
		t.Skipf("current account is unavailable: %v", err)
	}
	authenticateCGI := writeTestExecutable(t, "authenticate.cgi", "#!/bin/sh\nid -un\n")
	idBinary := writeTestExecutable(t, "id", "#!/bin/sh\nif [ \"$1\" = \"-Gn\" ]; then echo users; else echo 20; fi\n")
	configureDevelopmentAuthentication(t, authenticateCGI, idBinary)

	request := httptest.NewRequest("GET", "http://dsm.local/diskshell/ws", nil)
	request.Host = "dsm.local"
	request.Header.Set("Origin", "http://dsm.local")
	response := httptest.NewRecorder()
	terminal(response, request)
	if response.Code != 401 {
		t.Fatalf("non-administrator returned HTTP %d", response.Code)
	}
}

func TestTerminalRejectsCrossOriginBeforeAuthentication(t *testing.T) {
	request := httptest.NewRequest("GET", "http://dsm.local/diskshell/ws", nil)
	request.Host = "dsm.local"
	request.Header.Set("Origin", "https://attacker.example")
	response := httptest.NewRecorder()
	terminal(response, request)
	if response.Code != 403 {
		t.Fatalf("cross-origin request returned HTTP %d", response.Code)
	}
}

func TestTerminalRejectsWhenAuthenticationCapacityIsExhausted(t *testing.T) {
	fillSlots(t, authenticationSlots)
	request := httptest.NewRequest("GET", "http://dsm.local/diskshell/ws", nil)
	request.Host = "dsm.local"
	request.Header.Set("Origin", "http://dsm.local")
	response := httptest.NewRecorder()
	terminal(response, request)
	if response.Code != 503 {
		t.Fatalf("exhausted authentication capacity returned HTTP %d", response.Code)
	}
}

func TestTerminalRejectsWhenShellCapacityIsExhausted(t *testing.T) {
	fillSlots(t, shellSlots)
	manager := newSessionManager()
	if _, err := manager.create(&identity{username: "test", home: "/tmp"}, "Shell"); !errors.Is(err, errServiceBusy) {
		t.Fatalf("exhausted shell capacity returned %v", err)
	}
}

func TestAuthenticationContextCancelsHungCGI(t *testing.T) {
	authenticateCGI := writeTestExecutable(t, "authenticate.cgi", "#!/bin/sh\nexec sleep 5\n")
	idBinary := writeTestExecutable(t, "id", "#!/bin/sh\nexit 1\n")
	configureDevelopmentAuthentication(t, authenticateCGI, idBinary)
	request := httptest.NewRequest("GET", "http://dsm.local/diskshell/ws", nil)
	ctx, cancel := context.WithTimeout(request.Context(), 25*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := authenticateContext(ctx, request); err == nil {
		t.Fatal("hung authentication unexpectedly succeeded")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("authentication cancellation took %s", elapsed)
	}
}

func TestAuthenticationSlotIsReleasedAfterFailure(t *testing.T) {
	authenticateCGI := writeTestExecutable(t, "authenticate.cgi", "#!/bin/sh\nexit 1\n")
	idBinary := writeTestExecutable(t, "id", "#!/bin/sh\nexit 1\n")
	configureDevelopmentAuthentication(t, authenticateCGI, idBinary)
	request := httptest.NewRequest("GET", "http://dsm.local/diskshell/ws", nil)
	if _, err := authenticateWithSlot(request); err == nil {
		t.Fatal("invalid authentication unexpectedly succeeded")
	}
	if len(authenticationSlots) != 0 {
		t.Fatal("authentication slot was not released after failure")
	}
}

func TestShellSlotIsReleasedAfterUpgradeFailure(t *testing.T) {
	account, err := user.Current()
	if err != nil {
		t.Skipf("current account is unavailable: %v", err)
	}
	authenticateCGI := writeTestExecutable(t, "authenticate.cgi", "#!/bin/sh\nid -un\n")
	idBinary := writeTestExecutable(t, "id", "#!/bin/sh\nif [ \"$1\" = \"-Gn\" ]; then echo administrators; else echo "+account.Gid+"; fi\n")
	configureDevelopmentAuthentication(t, authenticateCGI, idBinary)
	request := httptest.NewRequest("GET", "http://dsm.local/diskshell/ws", nil)
	request.Host = "dsm.local"
	request.Header.Set("Origin", "http://dsm.local")
	response := httptest.NewRecorder()
	terminal(response, request)
	if len(shellSlots) != 0 {
		t.Fatal("shell slot was not released after WebSocket upgrade failure")
	}
}

func TestSessionOutputBufferIsBounded(t *testing.T) {
	first := make([]byte, maxSessionOutput-2)
	result := appendSessionOutput(first, []byte("abcd"))
	if len(result) != maxSessionOutput || string(result[len(result)-4:]) != "abcd" {
		t.Fatalf("unexpected bounded session output: %d bytes", len(result))
	}
}

func TestSessionNamesAreValidated(t *testing.T) {
	if !validSessionName("Backup job") || validSessionName("") || validSessionName("bad\nname") {
		t.Fatal("session name validation accepted an invalid value")
	}
	if validSessionName(strings.Repeat("x", maxSessionName+1)) {
		t.Fatal("oversized session name was accepted")
	}
}

func TestSessionRenameIsOwnerScopedAndNotifiesAttachment(t *testing.T) {
	manager := newSessionManager()
	attachment := &sessionAttachment{info: make(chan sessionInfo, 1), done: make(chan struct{})}
	session := &shellSession{
		manager: manager, id: "owned", owner: "alice", name: "Shell", persistent: true, running: true,
		attachment: attachment, lastActivity: time.Now(),
	}
	manager.sessions[session.id] = session
	if _, ok := manager.rename("bob", session.id, "Foreign"); ok {
		t.Fatal("another owner renamed the session")
	}
	info, ok := manager.rename("alice", session.id, "Backup")
	if !ok || info.Name != "Backup" {
		t.Fatalf("owned session was not renamed: %#v", info)
	}
	select {
	case update := <-attachment.info:
		if update.Name != "Backup" {
			t.Fatalf("unexpected rename update: %#v", update)
		}
	default:
		t.Fatal("attached client was not notified of rename")
	}
}

func TestSessionListingIsPersistentAndOwnerScoped(t *testing.T) {
	manager := newSessionManager()
	manager.sessions["owned"] = &shellSession{
		manager: manager, id: "owned", owner: "alice", name: "Backup", persistent: true, running: true, lastActivity: time.Now(),
	}
	manager.sessions["temporary"] = &shellSession{
		manager: manager, id: "temporary", owner: "alice", name: "Temporary", running: true, lastActivity: time.Now(),
	}
	manager.sessions["foreign"] = &shellSession{
		manager: manager, id: "foreign", owner: "bob", name: "Foreign", persistent: true, running: true, lastActivity: time.Now(),
	}
	sessions := manager.list("alice")
	if len(sessions) != 1 || sessions[0].ID != "owned" {
		t.Fatalf("unexpected owner-scoped sessions: %#v", sessions)
	}
}

func TestSessionReservationsAreLimitedPerOwner(t *testing.T) {
	manager := newSessionManager()
	for index := 0; index < maxUserSessions; index++ {
		if !manager.reserve("alice") {
			t.Fatalf("reservation %d was rejected", index)
		}
	}
	if manager.reserve("alice") {
		t.Fatal("owner session limit was not enforced")
	}
	if !manager.reserve("bob") {
		t.Fatal("one owner exhausted another owner's limit")
	}
}

func TestPersistentSessionCanDetachReplayReattachAndTerminate(t *testing.T) {
	account, err := user.Current()
	if err != nil {
		t.Skipf("current account is unavailable: %v", err)
	}
	authenticateCGI := writeTestExecutable(t, "authenticate.cgi", "#!/bin/sh\nid -un\n")
	idBinary := writeTestExecutable(t, "id", "#!/bin/sh\nif [ \"$1\" = \"-Gn\" ]; then echo administrators; else echo "+account.Gid+"; fi\n")
	configureDevelopmentAuthentication(t, authenticateCGI, idBinary)

	previousStore := sessionStore
	manager := newSessionManager()
	sessionStore = manager
	server := httptest.NewServer(http.HandlerFunc(terminal))
	t.Cleanup(func() {
		manager.shutdown()
		server.Close()
		sessionStore = previousStore
	})

	first := dialTestTerminal(t, server.URL)
	if err := first.WriteJSON(clientMessage{Type: "open", Name: "Background test"}); err != nil {
		t.Fatal(err)
	}
	opened := waitForSessionMessage(t, first, func(info sessionInfo) bool { return info.ID != "" })
	if err := first.WriteJSON(clientMessage{Type: "persist", Persistent: true}); err != nil {
		t.Fatal(err)
	}
	waitForSessionMessage(t, first, func(info sessionInfo) bool { return info.Persistent })
	marker := "__DISKSHELL_REPLAY__"
	if err := first.WriteJSON(clientMessage{Type: "input", Data: "printf '" + marker + "\\n'; sleep 30\n"}); err != nil {
		t.Fatal(err)
	}
	waitForTerminalOutput(t, first, marker)
	_ = first.Close()

	second := dialTestTerminal(t, server.URL)
	if err := second.WriteJSON(clientMessage{Type: "open", SessionID: opened.ID}); err != nil {
		t.Fatal(err)
	}
	waitForSessionMessage(t, second, func(info sessionInfo) bool { return info.ID == opened.ID })
	waitForTerminalOutput(t, second, marker)
	if err := second.WriteJSON(clientMessage{Type: "terminate"}); err != nil {
		t.Fatal(err)
	}
	_ = second.Close()

	deadline := time.Now().Add(5 * time.Second)
	for manager.find(account.Username, opened.ID) != nil || len(shellSlots) != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("terminated session remained registered or held a slot: sessions=%d slots=%d", len(manager.sessions), len(shellSlots))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func dialTestTerminal(t *testing.T, serverURL string) *websocket.Conn {
	t.Helper()
	header := http.Header{"Origin": []string{serverURL}}
	connection, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(serverURL, "http")+"/diskshell/ws", header)
	if err != nil {
		if response != nil {
			t.Fatalf("websocket dial returned HTTP %d: %v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	return connection
}

func waitForSessionMessage(t *testing.T, connection *websocket.Conn, accept func(sessionInfo) bool) sessionInfo {
	t.Helper()
	for {
		_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
		var message serverMessage
		if err := connection.ReadJSON(&message); err != nil {
			t.Fatalf("waiting for session message: %v", err)
		}
		if message.Type == "error" {
			t.Fatalf("terminal returned %s: %s", message.Code, message.Message)
		}
		if message.Type == "session" && message.Session != nil && accept(*message.Session) {
			return *message.Session
		}
	}
}

func waitForTerminalOutput(t *testing.T, connection *websocket.Conn, marker string) {
	t.Helper()
	var output strings.Builder
	for {
		_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
		var message serverMessage
		if err := connection.ReadJSON(&message); err != nil {
			t.Fatalf("waiting for terminal output %q: %v", marker, err)
		}
		if message.Type == "output" {
			output.WriteString(message.Data)
			if strings.Contains(output.String(), marker) {
				return
			}
		}
	}
}

func configureDevelopmentAuthentication(t *testing.T, authenticateCGI, idBinary string) {
	t.Helper()
	t.Setenv("DISKSHELL_DEVELOPMENT", "1")
	t.Setenv("DISKSHELL_AUTHENTICATE_CGI", authenticateCGI)
	t.Setenv("DISKSHELL_ID_BIN", idBinary)
}

func writeTestExecutable(t *testing.T, name, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(contents), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func fillSlots(t *testing.T, slots chan struct{}) {
	t.Helper()
	capacity := cap(slots)
	for index := 0; index < capacity; index++ {
		if !acquireSlot(slots) {
			t.Fatal("slot capacity was already in use")
		}
	}
	t.Cleanup(func() {
		for index := 0; index < capacity; index++ {
			releaseSlot(slots)
		}
	})
}
