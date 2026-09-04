package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"
)

const (
	maxUploadFileSize = 25 * 1024 * 1024
	maxUploadRequest  = 50 * 1024 * 1024
	maxUploadFiles    = 10
	maxUploadName     = 120
)

type uploadCollision string

const (
	collisionAsk      uploadCollision = "ask"
	collisionOverride uploadCollision = "override"
	collisionKeepBoth uploadCollision = "keep-both"
)

var errUploadConflict = errors.New("upload destination already exists")

type uploadInfo struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Size int64  `json:"size"`
}

type uploadResponse struct {
	Uploads []uploadInfo `json:"uploads"`
}

type uploadCheckRequest struct {
	SessionID string   `json:"sessionId"`
	Names     []string `json:"names"`
}

type uploadCheckResponse struct {
	Conflict bool   `json:"conflict"`
	Target   string `json:"target"`
}

var uploadTargetKey = func() []byte {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic(err)
	}
	return key
}()

type uploadTarget struct {
	Owner     string
	Session   string
	Directory string
	Expires   int64
}

func signUploadTarget(owner, session, directory string) string {
	body, _ := json.Marshal(uploadTarget{owner, session, directory, time.Now().Add(time.Hour).Unix()})
	mac := hmac.New(sha256.New, uploadTargetKey)
	mac.Write(body)
	return base64.RawURLEncoding.EncodeToString(body) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func verifyUploadTarget(token, owner, session, directory string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return false
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, uploadTargetKey)
	mac.Write(body)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return false
	}
	var target uploadTarget
	return json.Unmarshal(body, &target) == nil && target.Owner == owner && target.Session == session && target.Directory == directory && target.Expires > time.Now().Unix()
}

func uploadCheckIndex(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
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
	request.Body = http.MaxBytesReader(response, request.Body, 16*1024)
	var check uploadCheckRequest
	if err := json.NewDecoder(request.Body).Decode(&check); err != nil || len(check.Names) == 0 || len(check.Names) > maxUploadFiles {
		http.Error(response, "Invalid upload check.", http.StatusBadRequest)
		return
	}
	session := sessionStore.find(account.username, check.SessionID)
	if session == nil {
		http.Error(response, "The terminal session is no longer available.", http.StatusNotFound)
		return
	}
	directory, err := session.workingDirectory()
	if err != nil {
		http.Error(response, "The terminal working directory is unavailable.", http.StatusUnprocessableEntity)
		return
	}
	conflict, err := uploadNamesConflict(account, directory, check.Names)
	if err != nil {
		http.Error(response, "The upload destination could not be checked.", http.StatusUnprocessableEntity)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = jsonResponse(response, uploadCheckResponse{Conflict: conflict, Target: signUploadTarget(account.username, check.SessionID, directory)})
}

func uploadIndex(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
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
	session := sessionStore.find(account.username, request.URL.Query().Get("sessionId"))
	if session == nil {
		http.Error(response, "The terminal session is no longer available.", http.StatusNotFound)
		return
	}
	directory, err := session.workingDirectory()
	if err != nil {
		http.Error(response, "The terminal working directory is unavailable.", http.StatusUnprocessableEntity)
		return
	}
	collision := uploadCollision(request.URL.Query().Get("collision"))
	if !verifyUploadTarget(request.Header.Get("X-Upload-Target"), account.username, session.id, directory) {
		http.Error(response, "The upload destination changed. Drop the files again.", http.StatusPreconditionFailed)
		return
	}
	if collision == "" {
		collision = collisionAsk
	}
	if collision != collisionAsk && collision != collisionOverride && collision != collisionKeepBoth {
		http.Error(response, "Invalid upload collision action.", http.StatusBadRequest)
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxUploadRequest+1024*1024)
	reader, err := request.MultipartReader()
	if err != nil {
		http.Error(response, "A multipart file upload is required.", http.StatusBadRequest)
		return
	}
	uploads := make([]uploadInfo, 0, maxUploadFiles)
	for {
		part, nextError := reader.NextPart()
		if errors.Is(nextError, io.EOF) {
			break
		}
		if nextError != nil {
			http.Error(response, "The upload could not be read.", http.StatusBadRequest)
			return
		}
		if part.FormName() != "files" || part.FileName() == "" {
			_ = part.Close()
			continue
		}
		if len(uploads) >= maxUploadFiles {
			_ = part.Close()
			http.Error(response, "Too many files.", http.StatusRequestEntityTooLarge)
			return
		}
		info, saveError := saveUpload(account, directory, part.FileName(), collision, part)
		_ = part.Close()
		if saveError != nil {
			status := http.StatusUnprocessableEntity
			if errors.Is(saveError, errUploadConflict) {
				status = http.StatusConflict
			} else if strings.Contains(saveError.Error(), "25 MiB") {
				status = http.StatusRequestEntityTooLarge
			}
			http.Error(response, saveError.Error(), status)
			return
		}
		uploads = append(uploads, info)
	}
	if len(uploads) == 0 {
		http.Error(response, "No files were uploaded.", http.StatusBadRequest)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = jsonResponse(response, uploadResponse{Uploads: uploads})
}

func uploadNamesConflict(account *identity, directory string, names []string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	seen := make(map[string]struct{}, len(names))
	for _, originalName := range names {
		name := safeUploadName(originalName)
		if _, duplicate := seen[name]; duplicate {
			return true, nil
		}
		seen[name] = struct{}{}
		command := exec.CommandContext(ctx, "/bin/sh", "-c", `[ -e "$1" ] || [ -L "$1" ]`, "diskshell-upload-check", name)
		command.WaitDelay = time.Second
		command.Dir = directory
		if credential := commandCredential(account); credential != nil {
			command.SysProcAttr = &syscall.SysProcAttr{Credential: credential}
		}
		err := command.Run()
		if err == nil {
			return true, nil
		}
		if exitError, ok := err.(*exec.ExitError); !ok || exitError.ExitCode() != 1 {
			return false, err
		}
	}
	return false, nil
}

func saveUpload(account *identity, directory, originalName string, collision uploadCollision, source io.Reader) (uploadInfo, error) {
	temporary, err := os.CreateTemp("", "diskshell-upload-*")
	if err != nil {
		return uploadInfo{}, errors.New("The upload could not be staged.")
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	size, copyError := io.Copy(temporary, io.LimitReader(source, maxUploadFileSize+1))
	closeError := temporary.Close()
	if copyError != nil || closeError != nil {
		return uploadInfo{}, errors.New("The upload could not be read.")
	}
	if size > maxUploadFileSize {
		return uploadInfo{}, errors.New("A file exceeds the 25 MiB upload limit.")
	}

	name := safeUploadName(originalName)
	if collision == collisionKeepBoth {
		name = availableUploadName(directory, name)
	}
	path := filepath.Join(directory, name)
	staged, err := os.Open(temporaryPath)
	if err != nil {
		return uploadInfo{}, errors.New("The upload could not be committed.")
	}
	defer staged.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	command, err := uploadCommitCommand(ctx, account, directory, name, collision)
	if err != nil {
		return uploadInfo{}, err
	}
	command.Stdin = staged
	command.WaitDelay = time.Second
	command.Cancel = func() error { return syscall.Kill(-command.Process.Pid, syscall.SIGTERM) }
	if err := command.Run(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok && exitError.ExitCode() == 17 {
			return uploadInfo{}, errUploadConflict
		}
		return uploadInfo{}, errors.New("The file could not be created in the terminal directory.")
	}
	return uploadInfo{Name: name, Path: path, Size: size}, nil
}

func uploadCommitCommand(ctx context.Context, account *identity, directory, name string, collision uploadCollision) (*exec.Cmd, error) {
	identifier := make([]byte, 8)
	if _, err := rand.Read(identifier); err != nil {
		return nil, errors.New("The upload could not be created.")
	}
	temporaryName := ".diskshell-upload-" + hex.EncodeToString(identifier)
	noTargetDirectory := ""
	if runtime.GOOS == "linux" {
		// DSM ships GNU mv/ln. -T ensures a directory (or a symlink to one)
		// is handled as the destination entry, never as a directory to enter.
		noTargetDirectory = "-T"
	}
	var command *exec.Cmd
	if collision == collisionOverride {
		command = exec.CommandContext(ctx, "/bin/sh", "-c", `
umask 077
set -C
exec 3> "$2"
trap 'rm -f "$2"' 0 1 2 15
cat >&3 || exit 18
exec 3>&-
if [ -d "$1" ]; then exit 18; fi
mv -f ${3:+"$3"} -- "$2" "$1" || exit 18
trap - 0 1 2 15
`, "diskshell-upload", name, temporaryName, noTargetDirectory)
	} else {
		command = exec.CommandContext(ctx, "/bin/sh", "-c", `
umask 077
set -C
exec 3> "$2"
trap 'rm -f "$2"' 0 1 2 15
cat >&3 || exit 18
exec 3>&-
if [ -d "$1" ]; then exit 17; fi
if ! ln ${3:+"$3"} -- "$2" "$1"; then
  if [ -e "$1" ] || [ -L "$1" ]; then exit 17; fi
  exit 18
fi
rm -f "$2" || exit 18
trap - 0 1 2 15
`, "diskshell-upload", name, temporaryName, noTargetDirectory)
	}
	command.Dir = directory
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if credential := commandCredential(account); credential != nil {
		command.SysProcAttr.Credential = credential
	}
	return command, nil
}

func availableUploadName(directory, name string) string {
	if _, err := os.Lstat(filepath.Join(directory, name)); errors.Is(err, os.ErrNotExist) {
		return name
	}
	extension := filepath.Ext(name)
	stem := strings.TrimSuffix(name, extension)
	for index := 1; index < 10_000; index++ {
		candidate := stem + " (" + strconv.Itoa(index) + ")" + extension
		if _, err := os.Lstat(filepath.Join(directory, candidate)); errors.Is(err, os.ErrNotExist) {
			return candidate
		}
	}
	return stem + " (copy)" + extension
}

func commandCredential(account *identity) *syscall.Credential {
	if os.Geteuid() == 0 || uint32(os.Geteuid()) != account.uid || uint32(os.Getegid()) != account.gid {
		return &syscall.Credential{Uid: account.uid, Gid: account.gid, Groups: account.groups}
	}
	return nil
}

func safeUploadName(value string) string {
	value = filepath.Base(strings.ReplaceAll(value, "\\", "/"))
	var cleaned strings.Builder
	for _, character := range value {
		if unicode.IsControl(character) || character == '/' || character == '\\' {
			cleaned.WriteByte('_')
		} else {
			cleaned.WriteRune(character)
		}
		if cleaned.Len() >= maxUploadName {
			break
		}
	}
	result := strings.Trim(cleaned.String(), " .")
	if result == "" {
		return "upload"
	}
	return result
}
