package main

import (
	"context"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	account, err := user.Current()
	if err != nil {
		t.Skipf("current account is unavailable: %v", err)
	}
	authenticateCGI := writeTestExecutable(t, "authenticate.cgi", "#!/bin/sh\nid -un\n")
	idBinary := writeTestExecutable(t, "id", "#!/bin/sh\nif [ \"$1\" = \"-Gn\" ]; then echo administrators; else echo "+account.Gid+"; fi\n")
	configureDevelopmentAuthentication(t, authenticateCGI, idBinary)
	fillSlots(t, shellSlots)

	request := httptest.NewRequest("GET", "http://dsm.local/diskshell/ws", nil)
	request.Host = "dsm.local"
	request.Header.Set("Origin", "http://dsm.local")
	response := httptest.NewRecorder()
	terminal(response, request)
	if response.Code != 503 {
		t.Fatalf("exhausted shell capacity returned HTTP %d", response.Code)
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
