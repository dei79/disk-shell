package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"

	"github.com/creack/pty"
)

const (
	maxSessionOutput = 1024 * 1024
	maxSessionName   = 64
	maxUserSessions  = 4
)

type sessionInfo struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	State        string `json:"state"`
	Persistent   bool   `json:"persistent"`
	Attached     bool   `json:"attached"`
	LastActivity string `json:"lastActivity"`
}

type sessionAttachment struct {
	output chan []byte
	info   chan sessionInfo
	done   chan struct{}
	once   sync.Once
}

func (attachment *sessionAttachment) stop() {
	attachment.once.Do(func() { close(attachment.done) })
}

type shellSession struct {
	mu           sync.Mutex
	manager      *sessionManager
	id           string
	owner        string
	name         string
	command      *exec.Cmd
	terminalFile *os.File
	persistent   bool
	running      bool
	terminating  bool
	reaping      bool
	killFinished chan struct{}
	finished     chan struct{}
	output       []byte
	attachment   *sessionAttachment
	lastActivity time.Time
}

type sessionManager struct {
	mu       sync.Mutex
	sessions map[string]*shellSession
	pending  map[string]int
}

func newSessionManager() *sessionManager {
	return &sessionManager{sessions: make(map[string]*shellSession), pending: make(map[string]int)}
}

var sessionStore = newSessionManager()

func (manager *sessionManager) open(account *identity, sessionID, name string) (*shellSession, *sessionAttachment, []byte, error) {
	if sessionID != "" {
		session := manager.find(account.username, sessionID)
		if session == nil {
			return nil, nil, nil, errors.New("session not found")
		}
		attachment, snapshot := session.attach()
		return session, attachment, snapshot, nil
	}
	session, err := manager.create(account, name)
	if err != nil {
		return nil, nil, nil, err
	}
	attachment, snapshot := session.attach()
	return session, attachment, snapshot, nil
}

func (manager *sessionManager) create(account *identity, name string) (*shellSession, error) {
	if !manager.reserve(account.username) {
		return nil, errServiceBusy
	}
	if !acquireSlot(shellSlots) {
		manager.releaseReservation(account.username)
		return nil, errServiceBusy
	}
	identifier, err := randomSessionID()
	if err != nil {
		releaseSlot(shellSlots)
		manager.releaseReservation(account.username)
		return nil, err
	}
	if !validSessionName(name) {
		name = "Shell"
	}
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
	command.SysProcAttr = &syscall.SysProcAttr{}
	// The installed setuid service must always drop to the authenticated DSM
	// account. Unprivileged development tests already run as that account and
	// cannot call setgroups, even when the requested groups are unchanged.
	if os.Geteuid() == 0 || uint32(os.Geteuid()) != account.uid || uint32(os.Getegid()) != account.gid {
		command.SysProcAttr.Credential = &syscall.Credential{Uid: account.uid, Gid: account.gid, Groups: account.groups}
	}
	terminalFile, err := pty.StartWithSize(command, &pty.Winsize{Cols: 120, Rows: 36})
	if err != nil {
		releaseSlot(shellSlots)
		manager.releaseReservation(account.username)
		return nil, err
	}
	session := &shellSession{
		manager:      manager,
		id:           identifier,
		owner:        account.username,
		name:         name,
		command:      command,
		terminalFile: terminalFile,
		running:      true,
		lastActivity: time.Now(),
		finished:     make(chan struct{}),
	}
	manager.mu.Lock()
	manager.pending[account.username]--
	manager.sessions[identifier] = session
	manager.mu.Unlock()
	go session.run()
	return session, nil
}

func (manager *sessionManager) reserve(owner string) bool {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	count := manager.pending[owner]
	for _, session := range manager.sessions {
		if session.owner == owner {
			session.mu.Lock()
			running := session.running
			session.mu.Unlock()
			if running {
				count++
			}
		}
	}
	if count >= maxUserSessions {
		return false
	}
	manager.pending[owner]++
	return true
}

func (manager *sessionManager) releaseReservation(owner string) {
	manager.mu.Lock()
	manager.pending[owner]--
	manager.mu.Unlock()
}

func (manager *sessionManager) find(owner, identifier string) *shellSession {
	manager.mu.Lock()
	session := manager.sessions[identifier]
	manager.mu.Unlock()
	if session == nil || session.owner != owner {
		return nil
	}
	return session
}

func (manager *sessionManager) list(owner string) []sessionInfo {
	manager.mu.Lock()
	sessions := make([]*shellSession, 0, len(manager.sessions))
	for _, session := range manager.sessions {
		if session.owner == owner {
			sessions = append(sessions, session)
		}
	}
	manager.mu.Unlock()
	result := make([]sessionInfo, 0, len(sessions))
	for _, session := range sessions {
		info := session.info()
		if info.Persistent {
			result = append(result, info)
		}
	}
	sort.Slice(result, func(left, right int) bool { return result[left].LastActivity > result[right].LastActivity })
	return result
}

func (manager *sessionManager) remove(session *shellSession) {
	manager.mu.Lock()
	if manager.sessions[session.id] == session {
		delete(manager.sessions, session.id)
	}
	manager.mu.Unlock()
}

func (manager *sessionManager) terminate(owner, identifier string) bool {
	session := manager.find(owner, identifier)
	if session == nil {
		return false
	}
	session.terminate()
	return true
}

func (manager *sessionManager) rename(owner, identifier, name string) (sessionInfo, bool) {
	session := manager.find(owner, identifier)
	if session == nil {
		return sessionInfo{}, false
	}
	return session.rename(name)
}

func (manager *sessionManager) shutdown() {
	manager.mu.Lock()
	sessions := make([]*shellSession, 0, len(manager.sessions))
	for _, session := range manager.sessions {
		sessions = append(sessions, session)
	}
	manager.mu.Unlock()
	for _, session := range sessions {
		session.terminate()
	}
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for _, session := range sessions {
		if session.finished == nil {
			continue
		}
		select {
		case <-session.finished:
		case <-deadline.C:
			return
		}
	}
}

func (session *shellSession) attach() (*sessionAttachment, []byte) {
	attachment := &sessionAttachment{output: make(chan []byte, 64), info: make(chan sessionInfo, 1), done: make(chan struct{})}
	session.mu.Lock()
	previous := session.attachment
	session.attachment = attachment
	snapshot := append([]byte(nil), session.output...)
	running := session.running
	session.mu.Unlock()
	if previous != nil {
		previous.stop()
	}
	if !running {
		attachment.stop()
	}
	return attachment, snapshot
}

func (session *shellSession) detach(attachment *sessionAttachment) {
	session.mu.Lock()
	if session.attachment != attachment {
		session.mu.Unlock()
		return
	}
	session.attachment = nil
	persistent := session.persistent
	running := session.running
	session.mu.Unlock()
	attachment.stop()
	if !persistent {
		if running {
			session.terminate()
		} else {
			session.manager.remove(session)
		}
	}
}

func (session *shellSession) info() sessionInfo {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.infoLocked()
}

func (session *shellSession) infoLocked() sessionInfo {
	state := "exited"
	if session.running {
		state = "running"
	}
	return sessionInfo{
		ID:           session.id,
		Name:         session.name,
		State:        state,
		Persistent:   session.persistent,
		Attached:     session.attachment != nil,
		LastActivity: session.lastActivity.UTC().Format(time.RFC3339),
	}
}

func (session *shellSession) setPersistent(value bool) sessionInfo {
	session.mu.Lock()
	session.persistent = value
	info := session.infoLocked()
	attachment := session.attachment
	session.mu.Unlock()
	session.notify(attachment, info)
	return info
}

func (session *shellSession) rename(name string) (sessionInfo, bool) {
	if !validSessionName(name) {
		return session.info(), false
	}
	session.mu.Lock()
	session.name = strings.TrimSpace(name)
	info := session.infoLocked()
	attachment := session.attachment
	session.mu.Unlock()
	session.notify(attachment, info)
	return info, true
}

func (session *shellSession) notify(attachment *sessionAttachment, info sessionInfo) {
	if attachment == nil {
		return
	}
	select {
	case attachment.info <- info:
		return
	default:
	}
	select {
	case <-attachment.info:
	default:
	}
	select {
	case attachment.info <- info:
	case <-attachment.done:
	}
}

func (session *shellSession) write(data []byte) {
	session.mu.Lock()
	terminalFile := session.terminalFile
	running := session.running
	session.mu.Unlock()
	if running && terminalFile != nil {
		_, _ = terminalFile.Write(data)
	}
}

func (session *shellSession) resize(columns, rows uint16) {
	session.mu.Lock()
	terminalFile := session.terminalFile
	running := session.running
	session.mu.Unlock()
	if running && terminalFile != nil && validDimensions(columns, rows) {
		_ = pty.Setsize(terminalFile, &pty.Winsize{Cols: columns, Rows: rows})
	}
}

func (session *shellSession) run() {
	buffer := make([]byte, 16*1024)
	for {
		count, err := session.terminalFile.Read(buffer)
		if count > 0 {
			session.publish(buffer[:count])
		}
		if err != nil {
			break
		}
	}
	session.mu.Lock()
	killFinished := session.killFinished
	if killFinished == nil {
		session.reaping = true
	}
	session.mu.Unlock()
	if killFinished != nil {
		<-killFinished
	}
	_ = session.command.Wait()
	_ = session.terminalFile.Close()
	session.finish()
}

func (session *shellSession) publish(data []byte) {
	chunk := append([]byte(nil), data...)
	session.mu.Lock()
	session.output = appendSessionOutput(session.output, chunk)
	session.lastActivity = time.Now()
	attachment := session.attachment
	session.mu.Unlock()
	if attachment == nil {
		return
	}
	select {
	case attachment.output <- chunk:
	default:
		session.detach(attachment)
	}
}

func (session *shellSession) finish() {
	session.mu.Lock()
	session.running = false
	attachment := session.attachment
	session.lastActivity = time.Now()
	session.mu.Unlock()
	releaseSlot(shellSlots)
	if attachment != nil {
		attachment.stop()
	}
	// A completed shell is no longer a background process. Removing it here
	// also bounds retained output when users create many short-lived sessions.
	session.manager.remove(session)
	if session.finished != nil {
		close(session.finished)
	}
}

func (session *shellSession) terminate() {
	session.mu.Lock()
	if !session.running || session.terminating || session.reaping {
		session.persistent = false
		running := session.running
		session.mu.Unlock()
		if !running {
			session.manager.remove(session)
		}
		return
	}
	session.terminating = true
	session.persistent = false
	session.killFinished = make(chan struct{})
	killFinished := session.killFinished
	processID := session.command.Process.Pid
	session.mu.Unlock()
	go func() {
		_ = syscall.Kill(-processID, syscall.SIGTERM)
		<-time.After(2 * time.Second)
		// run deliberately keeps the process leader unreaped until this final
		// group signal, preventing its process-group ID from being reused.
		_ = syscall.Kill(-processID, syscall.SIGKILL)
		close(killFinished)
	}()
}

func appendSessionOutput(current, data []byte) []byte {
	current = append(current, data...)
	if len(current) <= maxSessionOutput {
		return current
	}
	trimmed := make([]byte, maxSessionOutput)
	copy(trimmed, current[len(current)-maxSessionOutput:])
	return trimmed
}

func validSessionName(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxSessionName {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func randomSessionID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}
