package service

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// EnvState holds shared environment variable state.
type EnvState struct {
	mu          sync.RWMutex
	vars        map[string]string
	DefaultUser string
}

func NewEnvState() *EnvState {
	return &EnvState{
		vars:        make(map[string]string),
		DefaultUser: "user",
	}
}

// Set adds or updates environment variables.
func (e *EnvState) Set(vars map[string]string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for k, v := range vars {
		e.vars[k] = v
	}
}

// Environ returns os.Environ() merged with stored vars.
func (e *EnvState) Environ() []string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	env := os.Environ()
	for k, v := range e.vars {
		env = append(env, k+"="+v)
	}
	return env
}

// HandleHealth returns 204.
func HandleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

// HandleInit sets environment variables and default user.
func HandleInit(state *EnvState) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			EnvVars     map[string]string `json:"envVars"`
			DefaultUser string            `json:"defaultUser"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		state.Set(req.EnvVars)
		if req.DefaultUser != "" {
			state.mu.Lock()
			state.DefaultUser = req.DefaultUser
			state.mu.Unlock()
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// HandleEnvs returns stored environment variables as JSON.
func HandleEnvs(state *EnvState) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		state.mu.RLock()
		defer state.mu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(state.vars)
	}
}

// HandleFiles handles file upload/download via REST.
func HandleFiles(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, `{"error":"path required"}`, http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodGet:
		info, err := os.Stat(path)
		if err != nil {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		if info.IsDir() {
			entries, err := os.ReadDir(path)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			type entry struct {
				Name  string `json:"name"`
				IsDir bool   `json:"isDir"`
				Path  string `json:"path"`
			}
			var result []entry
			for _, e := range entries {
				result = append(result, entry{
					Name:  e.Name(),
					IsDir: e.IsDir(),
					Path:  filepath.Join(path, e.Name()),
				})
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(result)
			return
		}
		http.ServeFile(w, r, path)

	case http.MethodPost, http.MethodPut:
		type entryInfo struct {
			Name string `json:"name"`
			Path string `json:"path"`
			Type string `json:"type"`
		}

		reader, err := r.MultipartReader()
		if err != nil {
			// Fallback: plain body upload
			if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			body, _ := io.ReadAll(r.Body)
			if err := os.WriteFile(path, body, 0644); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]entryInfo{{Name: filepath.Base(path), Path: path, Type: "file"}})
			return
		}

		var entries []entryInfo
		for {
			part, partErr := reader.NextPart()
			if partErr == io.EOF {
				break
			}
			if partErr != nil {
				http.Error(w, partErr.Error(), http.StatusInternalServerError)
				return
			}
			if part.FormName() != "file" {
				part.Close()
				continue
			}

			// Use path as-is for single file upload.
			// Only append filename if path looks like a directory (ends with /).
			filePath := path
			if strings.HasSuffix(path, "/") && part.FileName() != "" {
				filePath = filepath.Join(path, part.FileName())
			}

			if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
				part.Close()
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}

			f, err := os.OpenFile(filePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
			if err != nil {
				part.Close()
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			io.Copy(f, part)
			f.Close()
			part.Close()

			entries = append(entries, entryInfo{
				Name: filepath.Base(filePath),
				Path: filePath,
				Type: "file",
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(entries)

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}
