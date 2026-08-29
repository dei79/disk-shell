package main

import (
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

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

const (
	listenAddress  = "127.0.0.1:16082"
	maxMessageSize = 64 * 1024
)

type clientMessage struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

type serverMessage struct {
	Type    string `json:"type"`
	Data    string `json:"data,omitempty"`
	Message string `json:"message,omitempty"`
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
		log.Fatal("dsm-terminal-server must be installed with its DSM setuid privilege")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/dsm-terminal/health", health)
	mux.HandleFunc("/dsm-terminal/ws", terminal)
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
		_ = server.Close()
	}()

	log.Printf("DSM Terminal listening on %s", listenAddress)
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
	account, err := authenticate(request)
	if err != nil {
		log.Printf("Terminal authentication rejected: %v", err)
		http.Error(response, "A valid DSM administrator login is required.", http.StatusUnauthorized)
		return
	}

	connection, err := upgrader.Upgrade(response, request, nil)
	if err != nil {
		return
	}
	defer connection.Close()
	connection.SetReadLimit(maxMessageSize)

	command := exec.Command("/bin/sh", "-l")
	command.Dir = account.home
	command.Env = []string{
		"HOME=" + account.home,
		"LANG=C.UTF-8",
		"LOGNAME=" + account.username,
		"PATH=/usr/local/bin:/usr/bin:/bin:/usr/syno/bin:/usr/syno/sbin",
		"SHELL=/bin/sh",
		"TERM=xterm-256color",
		"USER=" + account.username,
	}
	command.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: account.uid, Gid: account.gid, Groups: account.groups},
	}
	terminalFile, err := pty.StartWithSize(command, &pty.Winsize{Cols: 120, Rows: 36})
	if err != nil {
		_ = connection.WriteJSON(serverMessage{Type: "error", Message: "Die DSM-Shell konnte nicht gestartet werden."})
		return
	}
	defer terminalFile.Close()
	defer func() { _ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL) }()

	outputFinished := make(chan struct{})
	go func() {
		defer close(outputFinished)
		buffer := make([]byte, 16*1024)
		for {
			count, readError := terminalFile.Read(buffer)
			if count > 0 {
				_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if writeError := connection.WriteJSON(serverMessage{Type: "output", Data: string(buffer[:count])}); writeError != nil {
					return
				}
			}
			if readError != nil {
				return
			}
		}
	}()

	for {
		var message clientMessage
		if err := connection.ReadJSON(&message); err != nil {
			break
		}
		switch message.Type {
		case "input":
			if len(message.Data) > maxMessageSize {
				return
			}
			_, _ = terminalFile.Write([]byte(message.Data))
		case "resize":
			if validDimensions(message.Cols, message.Rows) {
				_ = pty.Setsize(terminalFile, &pty.Winsize{Cols: message.Cols, Rows: message.Rows})
			}
		default:
			return
		}
	}

	_ = syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
	select {
	case <-outputFinished:
	case <-time.After(2 * time.Second):
	}
	_ = command.Wait()
}

func authenticate(request *http.Request) (*identity, error) {
	authenticateCGI := "/usr/syno/synoman/webman/modules/authenticate.cgi"
	idBinary := "/usr/bin/id"
	// Never honor path overrides while this installed setuid program is running
	// with more privilege than its caller. They are only for unprivileged tests.
	if os.Getuid() == os.Geteuid() && os.Getenv("DSM_TERMINAL_DEVELOPMENT") == "1" {
		if value := os.Getenv("DSM_TERMINAL_AUTHENTICATE_CGI"); value != "" {
			authenticateCGI = value
		}
		if value := os.Getenv("DSM_TERMINAL_ID_BIN"); value != "" {
			idBinary = value
		}
	}

	command := exec.Command(authenticateCGI)
	command.Env = cgiEnvironment(request)
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("DSM session lookup failed: %w", err)
	}
	username := strings.TrimSpace(string(output))
	if !validUsername(username) {
		return nil, errors.New("DSM session lookup returned no valid account")
	}
	groups, err := exec.Command(idBinary, "-Gn", username).Output()
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
	groupIDs, err := exec.Command(idBinary, "-G", username).Output()
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
