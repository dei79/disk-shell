package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"unicode"
)

const (
	maxUploadFileSize = 25 * 1024 * 1024
	maxUploadRequest  = 50 * 1024 * 1024
	maxUploadFiles    = 10
	maxUploadStorage  = 100 * 1024 * 1024
	maxUploadName     = 120
)

type uploadInfo struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Size int64  `json:"size"`
}

type uploadResponse struct {
	Uploads []uploadInfo `json:"uploads"`
}

var uploadLock sync.Mutex

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
			removeUploads(uploads)
			http.Error(response, "The upload could not be read.", http.StatusBadRequest)
			return
		}
		if part.FormName() != "files" || part.FileName() == "" {
			_ = part.Close()
			continue
		}
		if len(uploads) >= maxUploadFiles {
			_ = part.Close()
			removeUploads(uploads)
			http.Error(response, "Too many files.", http.StatusRequestEntityTooLarge)
			return
		}
		info, saveError := saveUpload(account, part.FileName(), part)
		_ = part.Close()
		if saveError != nil {
			removeUploads(uploads)
			http.Error(response, saveError.Error(), http.StatusRequestEntityTooLarge)
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

func removeUploads(uploads []uploadInfo) {
	for _, upload := range uploads {
		_ = os.Remove(upload.Path)
	}
}

func saveUpload(account *identity, originalName string, source io.Reader) (uploadInfo, error) {
	uploadLock.Lock()
	defer uploadLock.Unlock()
	directory, err := ensureUploadDirectory(account)
	if err != nil {
		return uploadInfo{}, errors.New("The upload directory is unavailable.")
	}
	used, err := directoryBytes(directory)
	if err != nil || used >= maxUploadStorage {
		return uploadInfo{}, errors.New("The upload storage limit has been reached.")
	}
	identifier := make([]byte, 8)
	if _, err := rand.Read(identifier); err != nil {
		return uploadInfo{}, errors.New("The upload could not be created.")
	}
	name := safeUploadName(originalName)
	path := filepath.Join(directory, hex.EncodeToString(identifier)+"-"+name)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return uploadInfo{}, errors.New("The upload could not be created.")
	}
	size, copyError := io.Copy(file, io.LimitReader(source, maxUploadFileSize+1))
	closeError := file.Close()
	if copyError != nil || closeError != nil || size > maxUploadFileSize || used+size > maxUploadStorage {
		_ = os.Remove(path)
		if size > maxUploadFileSize {
			return uploadInfo{}, errors.New("A file exceeds the 25 MiB upload limit.")
		}
		return uploadInfo{}, errors.New("The upload storage limit has been reached.")
	}
	if err := os.Chown(path, int(account.uid), int(account.gid)); err != nil {
		_ = os.Remove(path)
		return uploadInfo{}, errors.New("The uploaded file could not be assigned to the DSM account.")
	}
	return uploadInfo{Name: name, Path: path, Size: size}, nil
}

func ensureUploadDirectory(account *identity) (string, error) {
	root := "/var/packages/DiskShell/var/uploads"
	if os.Getuid() == os.Geteuid() && os.Getenv("DISKSHELL_DEVELOPMENT") == "1" {
		if override := os.Getenv("DISKSHELL_UPLOAD_ROOT"); override != "" {
			root = override
		}
	}
	if err := os.MkdirAll(root, 0o711); err != nil {
		return "", err
	}
	rootInfo, err := os.Lstat(root)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("invalid upload root")
	}
	directory := filepath.Join(root, strconv.FormatUint(uint64(account.uid), 10))
	if err := os.Mkdir(directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("invalid account upload directory")
	}
	if err := os.Chown(directory, int(account.uid), int(account.gid)); err != nil {
		return "", err
	}
	return directory, nil
}

func directoryBytes(directory string) (int64, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			return 0, err
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
	}
	return total, nil
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
