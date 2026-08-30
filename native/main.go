package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const (
	listenAddress                = "127.0.0.1:16082"
	maxMessageSize               = 64 * 1024
	maxConcurrentAuthentications = 8
	maxConcurrentShells          = 8
	authenticationTimeout        = 10 * time.Second
	firstMessageTimeout          = 30 * time.Second
	websocketPongWait            = 70 * time.Second
	websocketPingPeriod          = 30 * time.Second
	synoTokenProtocolPrefix      = "diskshell.syno-token."
)

var (
	authenticationSlots = make(chan struct{}, maxConcurrentAuthentications)
	shellSlots          = make(chan struct{}, maxConcurrentShells)
)

type clientMessage struct {
	Type       string `json:"type"`
	Data       string `json:"data,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
	Name       string `json:"name,omitempty"`
	Persistent bool   `json:"persistent,omitempty"`
	Cols       uint16 `json:"cols,omitempty"`
	Rows       uint16 `json:"rows,omitempty"`
}

type serverMessage struct {
	Type     string        `json:"type"`
	Data     string        `json:"data,omitempty"`
	Code     string        `json:"code,omitempty"`
	Message  string        `json:"message,omitempty"`
	Session  *sessionInfo  `json:"session,omitempty"`
	Sessions []sessionInfo `json:"sessions,omitempty"`
}

type identity struct {
	username string
	uid      uint32
	gid      uint32
	groups   []uint32
	home     string
}

var upgrader = websocket.Upgrader{
	HandshakeTimeout: 10 * time.Second,
	ReadBufferSize:   4096,
	WriteBufferSize:  4096,
	CheckOrigin:      allowedOrigin,
}

func main() {
	if os.Geteuid() != 0 {
		log.Fatal("diskshell-server must be installed with its DSM setuid privilege")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/diskshell/health", health)
	mux.HandleFunc("/diskshell/sessions", sessionIndex)
	mux.HandleFunc("/diskshell/uploads", uploadIndex)
	mux.HandleFunc("/diskshell/ws", terminal)
	server := &http.Server{
		Addr:              listenAddress,
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       70 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		sessionStore.shutdown()
		_ = server.Close()
	}()

	log.Printf("DiskShell listening on %s", listenAddress)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("X-Frame-Options", "SAMEORIGIN")
		next.ServeHTTP(response, request)
	})
}

func health(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		http.Error(response, "Method not allowed.", http.StatusMethodNotAllowed)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = io.WriteString(response, `{"status":"ok"}`+"\n")
}

func terminal(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || !allowedOrigin(request) {
		http.Error(response, "Forbidden.", http.StatusForbidden)
		return
	}
	token, selectedProtocol, err := synoTokenFromSubprotocol(request)
	if err != nil {
		http.Error(response, "Forbidden.", http.StatusForbidden)
		return
	} else if token != "" {
		request.Header.Set("X-Syno-Token", token)
	}
	account, err := authenticateWithSlot(request)
	if err != nil {
		if errors.Is(err, errServiceBusy) {
			http.Error(response, "The terminal service is busy.", http.StatusServiceUnavailable)
			return
		}
		log.Printf("Terminal authentication rejected: %v", err)
		http.Error(response, "A valid DSM administrator login is required.", http.StatusUnauthorized)
		return
	}
	upgradeHeader := make(http.Header)
	if selectedProtocol != "" {
		upgradeHeader.Set("Sec-WebSocket-Protocol", selectedProtocol)
	}
	connection, err := upgrader.Upgrade(response, request, upgradeHeader)
	if err != nil {
		return
	}
	defer connection.Close()
	connection.SetReadLimit(maxMessageSize)
	_ = connection.SetReadDeadline(time.Now().Add(firstMessageTimeout))
	var firstMessage clientMessage
	if err := connection.ReadJSON(&firstMessage); err != nil || firstMessage.Type != "open" {
		_ = connection.WriteJSON(serverMessage{Type: "error", Code: "invalid_open", Message: "The terminal session could not be opened."})
		return
	}
	session, attachment, snapshot, err := sessionStore.open(account, firstMessage.SessionID, firstMessage.Name)
	if err != nil {
		code := "session_not_found"
		message := "The terminal session is no longer available."
		if errors.Is(err, errServiceBusy) {
			code = "service_busy"
			message = "The terminal service is busy."
		}
		_ = connection.WriteJSON(serverMessage{Type: "error", Code: code, Message: message})
		return
	}
	defer session.detach(attachment)
	info := session.info()
	if err := connection.WriteJSON(serverMessage{Type: "session", Session: &info}); err != nil {
		return
	}
	for len(snapshot) > 0 {
		count := min(len(snapshot), 16*1024)
		if err := connection.WriteJSON(serverMessage{Type: "output", Data: string(snapshot[:count])}); err != nil {
			return
		}
		snapshot = snapshot[count:]
	}
	pingFinished := make(chan struct{})
	defer close(pingFinished)
	outputFinished := make(chan struct{})
	go func() {
		defer close(outputFinished)
		defer connection.Close()
		for {
			select {
			case data := <-attachment.output:
				_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if writeError := connection.WriteJSON(serverMessage{Type: "output", Data: string(data)}); writeError != nil {
					return
				}
			case info := <-attachment.info:
				_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := connection.WriteJSON(serverMessage{Type: "session", Session: &info}); err != nil {
					return
				}
			case <-attachment.done:
				return
			}
		}
	}()
	connection.SetPongHandler(func(string) error {
		return connection.SetReadDeadline(time.Now().Add(websocketPongWait))
	})
	_ = connection.SetReadDeadline(time.Now().Add(websocketPongWait))
	go pingWebSocket(connection, pingFinished)

terminalLoop:
	for {
		var message clientMessage
		if err := connection.ReadJSON(&message); err != nil {
			break
		}
		switch message.Type {
		case "input":
			if len(message.Data) > maxMessageSize {
				break terminalLoop
			}
			session.write([]byte(message.Data))
		case "resize":
			session.resize(message.Cols, message.Rows)
		case "persist":
			session.setPersistent(message.Persistent)
		case "rename":
			session.rename(message.Name)
		case "terminate":
			session.terminate()
			break terminalLoop
		default:
			break terminalLoop
		}
	}
	select {
	case <-outputFinished:
	case <-time.After(2 * time.Second):
	}
}

func sessionIndex(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodDelete && request.Method != http.MethodPatch {
		http.Error(response, "Method not allowed.", http.StatusMethodNotAllowed)
		return
	}
	if origin := request.Header.Get("Origin"); origin != "" && !allowedOrigin(request) {
		http.Error(response, "Forbidden.", http.StatusForbidden)
		return
	}
	account, err := authenticateWithSlot(request)
	if err != nil {
		http.Error(response, "A valid DSM administrator login is required.", http.StatusUnauthorized)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	if request.Method == http.MethodPatch {
		request.Body = http.MaxBytesReader(response, request.Body, 4096)
		var message clientMessage
		if err := json.NewDecoder(request.Body).Decode(&message); err != nil {
			http.Error(response, "Invalid session name.", http.StatusBadRequest)
			return
		}
		info, ok := sessionStore.rename(account.username, request.URL.Query().Get("id"), message.Name)
		if !ok {
			http.Error(response, "Session not found or invalid name.", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(response).Encode(serverMessage{Type: "session", Session: &info})
		return
	}
	if request.Method == http.MethodDelete {
		if !sessionStore.terminate(account.username, request.URL.Query().Get("id")) {
			http.Error(response, "Session not found.", http.StatusNotFound)
			return
		}
		_, _ = io.WriteString(response, `{"success":true}`+"\n")
		return
	}
	_ = json.NewEncoder(response).Encode(serverMessage{Type: "sessions", Sessions: sessionStore.list(account.username)})
}

var errServiceBusy = errors.New("terminal service is busy")

func authenticateWithSlot(request *http.Request) (*identity, error) {
	if !acquireSlot(authenticationSlots) {
		return nil, errServiceBusy
	}
	defer releaseSlot(authenticationSlots)
	return authenticate(request)
}

func authenticate(request *http.Request) (*identity, error) {
	ctx, cancel := context.WithTimeout(request.Context(), authenticationTimeout)
	defer cancel()
	return authenticateContext(ctx, request)
}

func authenticateContext(ctx context.Context, request *http.Request) (*identity, error) {
	authenticateCGI := "/usr/syno/synoman/webman/modules/authenticate.cgi"
	idBinary := "/usr/bin/id"
	// Never honor path overrides while this installed setuid program is running
	// with more privilege than its caller. They are only for unprivileged tests.
	if os.Getuid() == os.Geteuid() && os.Getenv("DISKSHELL_DEVELOPMENT") == "1" {
		if value := os.Getenv("DISKSHELL_AUTHENTICATE_CGI"); value != "" {
			authenticateCGI = value
		}
		if value := os.Getenv("DISKSHELL_ID_BIN"); value != "" {
			idBinary = value
		}
	}

	command := exec.CommandContext(ctx, authenticateCGI)
	command.Env = cgiEnvironment(request)
	command.WaitDelay = time.Second
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("DSM session lookup failed: %w", err)
	}
	username := strings.TrimSpace(string(output))
	if !validUsername(username) {
		return nil, errors.New("DSM session lookup returned no valid account")
	}
	groupsCommand := exec.CommandContext(ctx, idBinary, "-Gn", username)
	groupsCommand.WaitDelay = time.Second
	groups, err := groupsCommand.Output()
	if err != nil {
		return nil, fmt.Errorf("DSM group lookup failed: %w", err)
	}
	if !containsWord(string(groups), "administrators") {
		return nil, errors.New("administrator permission required")
	}
	account, err := user.Lookup(username)
	if err != nil {
		return nil, err
	}
	uid, err := parseID(account.Uid)
	if err != nil {
		return nil, err
	}
	gid, err := parseID(account.Gid)
	if err != nil {
		return nil, err
	}
	groupIDsCommand := exec.CommandContext(ctx, idBinary, "-G", username)
	groupIDsCommand.WaitDelay = time.Second
	groupIDs, err := groupIDsCommand.Output()
	if err != nil {
		return nil, fmt.Errorf("DSM numeric group lookup failed: %w", err)
	}
	numericGroups, err := parseGroupIDs(string(groupIDs))
	if err != nil {
		return nil, err
	}
	home := shellHome(account.HomeDir)
	return &identity{username: username, uid: uid, gid: gid, groups: numericGroups, home: home}, nil
}

func synoTokenFromSubprotocol(request *http.Request) (string, string, error) {
	for _, protocol := range websocket.Subprotocols(request) {
		if !strings.HasPrefix(protocol, synoTokenProtocolPrefix) {
			continue
		}
		encoded := strings.TrimPrefix(protocol, synoTokenProtocolPrefix)
		decoded, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil || len(decoded) == 0 || len(decoded) > 4096 {
			return "", "", errors.New("invalid SynoToken subprotocol")
		}
		for _, character := range decoded {
			if character < 0x21 || character == 0x7f {
				return "", "", errors.New("invalid SynoToken characters")
			}
		}
		return string(decoded), protocol, nil
	}
	return "", "", nil
}

func acquireSlot(slots chan struct{}) bool {
	select {
	case slots <- struct{}{}:
		return true
	default:
		return false
	}
}

func releaseSlot(slots chan struct{}) {
	<-slots
}

func pingWebSocket(connection *websocket.Conn, finished <-chan struct{}) {
	ticker := time.NewTicker(websocketPingPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := connection.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
				return
			}
		case <-finished:
			return
		}
	}
}

func cgiEnvironment(request *http.Request) []string {
	host, _, _ := net.SplitHostPort(request.RemoteAddr)
	if host == "" {
		host = request.RemoteAddr
	}
	return []string{
		"GATEWAY_INTERFACE=CGI/1.1",
		"PATH=/usr/syno/bin:/usr/bin:/bin",
		"REQUEST_METHOD=GET",
		"QUERY_STRING=" + request.URL.RawQuery,
		"HTTP_COOKIE=" + request.Header.Get("Cookie"),
		"HTTP_HOST=" + request.Host,
		"HTTP_USER_AGENT=" + request.Header.Get("User-Agent"),
		"HTTP_X_SYNO_TOKEN=" + request.Header.Get("X-Syno-Token"),
		"REMOTE_ADDR=" + host,
	}
}

func allowedOrigin(request *http.Request) bool {
	origin := request.Header.Get("Origin")
	if origin == "" || request.Host == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	return strings.EqualFold(parsed.Host, request.Host)
}

func validUsername(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if character == '\n' || character == '\r' || character == 0 {
			return false
		}
	}
	return true
}

func containsWord(value, expected string) bool {
	for _, word := range strings.Fields(value) {
		if word == expected {
			return true
		}
	}
	return false
}

func parseID(value string) (uint32, error) {
	parsed, err := strconv.ParseUint(value, 10, 32)
	return uint32(parsed), err
}

func parseGroupIDs(value string) ([]uint32, error) {
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return nil, errors.New("DSM numeric group lookup returned no groups")
	}
	groups := make([]uint32, 0, len(fields))
	for _, field := range fields {
		group, err := parseID(field)
		if err != nil {
			return nil, fmt.Errorf("invalid DSM group ID %q: %w", field, err)
		}
		groups = append(groups, group)
	}
	return groups, nil
}

func shellHome(value string) string {
	info, err := os.Stat(value)
	if value == "" || err != nil || !info.IsDir() {
		return "/tmp"
	}
	return value
}

func validDimensions(columns, rows uint16) bool {
	return columns >= 20 && columns <= 400 && rows >= 5 && rows <= 200
}

func debugMessage(value interface{}) string {
	encoded, _ := json.Marshal(value)
	return fmt.Sprintf("%s", encoded)
}

func jsonResponse(response http.ResponseWriter, value interface{}) error {
	return json.NewEncoder(response).Encode(value)
}
