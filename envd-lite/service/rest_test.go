package service

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandleHealth(t *testing.T) {
	w := httptest.NewRecorder()
	HandleHealth(w, httptest.NewRequest("GET", "/health", nil))
	if w.Code != http.StatusNoContent {
		t.Errorf("status=%d", w.Code)
	}
}

func TestEnvState_SetAndEnviron(t *testing.T) {
	s := NewEnvState()
	s.Set(map[string]string{"FOO": "BAR"})
	env := s.Environ()
	found := false
	for _, e := range env {
		if e == "FOO=BAR" {
			found = true
		}
	}
	if !found {
		t.Errorf("FOO=BAR missing from %v", env)
	}
}

func TestHandleInit(t *testing.T) {
	state := NewEnvState()
	body := strings.NewReader(`{"envVars":{"K":"V"},"defaultUser":"alice"}`)
	w := httptest.NewRecorder()
	HandleInit(state)(w, httptest.NewRequest("POST", "/init", body))
	if w.Code != http.StatusNoContent {
		t.Errorf("status=%d body=%s", w.Code, w.Body.String())
	}
	if state.DefaultUser != "alice" {
		t.Errorf("user=%s", state.DefaultUser)
	}

	// Wrong method.
	w = httptest.NewRecorder()
	HandleInit(state)(w, httptest.NewRequest("GET", "/init", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}

	// Bad json.
	w = httptest.NewRecorder()
	HandleInit(state)(w, httptest.NewRequest("POST", "/init", strings.NewReader("not json")))
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestHandleEnvs(t *testing.T) {
	state := NewEnvState()
	state.Set(map[string]string{"X": "Y"})
	w := httptest.NewRecorder()
	HandleEnvs(state)(w, httptest.NewRequest("GET", "/envs", nil))
	var got map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["X"] != "Y" {
		t.Errorf("got %v", got)
	}
}

func TestHandleFiles_GetMissingPath(t *testing.T) {
	w := httptest.NewRecorder()
	HandleFiles(w, httptest.NewRequest("GET", "/files", nil))
	if w.Code != http.StatusBadRequest {
		t.Errorf("status=%d", w.Code)
	}
}

func TestHandleFiles_GetNotFound(t *testing.T) {
	w := httptest.NewRecorder()
	HandleFiles(w, httptest.NewRequest("GET", "/files?path=/no/such/file", nil))
	if w.Code != http.StatusNotFound {
		t.Errorf("status=%d", w.Code)
	}
}

func TestHandleFiles_GetFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f.txt")
	os.WriteFile(p, []byte("payload"), 0644)

	w := httptest.NewRecorder()
	HandleFiles(w, httptest.NewRequest("GET", "/files?path="+p, nil))
	if w.Code != http.StatusOK {
		t.Errorf("status=%d", w.Code)
	}
	if w.Body.String() != "payload" {
		t.Errorf("body=%q", w.Body.String())
	}
}

func TestHandleFiles_GetDir(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a"), nil, 0644)
	os.MkdirAll(filepath.Join(dir, "sub"), 0755)

	w := httptest.NewRecorder()
	HandleFiles(w, httptest.NewRequest("GET", "/files?path="+dir, nil))
	if w.Code != http.StatusOK {
		t.Errorf("status=%d", w.Code)
	}
	var got []struct {
		Name  string `json:"name"`
		IsDir bool   `json:"isDir"`
	}
	json.Unmarshal(w.Body.Bytes(), &got)
	if len(got) != 2 {
		t.Errorf("got %d entries", len(got))
	}
}

func TestHandleFiles_PostPlainBody(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "uploaded.txt")
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/files?path="+p, strings.NewReader("hello"))
	HandleFiles(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("status=%d body=%s", w.Code, w.Body.String())
	}
	data, _ := os.ReadFile(p)
	if string(data) != "hello" {
		t.Errorf("got %q", string(data))
	}
}

func TestHandleFiles_PostMultipart(t *testing.T) {
	dir := t.TempDir()

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "u.txt")
	io.Copy(fw, strings.NewReader("multi"))
	mw.Close()

	target := filepath.Join(dir, "u.txt")
	req := httptest.NewRequest("POST", "/files?path="+target, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	w := httptest.NewRecorder()
	HandleFiles(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	data, _ := os.ReadFile(target)
	if string(data) != "multi" {
		t.Errorf("got %q", string(data))
	}
}

func TestHandleFiles_MethodNotAllowed(t *testing.T) {
	w := httptest.NewRecorder()
	HandleFiles(w, httptest.NewRequest("DELETE", "/files?path=/tmp/x", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status=%d", w.Code)
	}
}
