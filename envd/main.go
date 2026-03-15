// envd-lite: Minimal envd for macOS VMs (Tart backend).
// Implements the E2B envd API surface needed by the SDK:
//   - GET  /health → 204
//   - POST /init   → 204
//   - GET  /envs   → env vars JSON
//   - GET/POST /files → file download/upload (REST, OpenAPI)
//   - connectrpc Process service (Start, Connect, SendInput, SendSignal, etc.)
//   - connectrpc Filesystem service (Stat, ListDir, MakeDir, Remove, Move)
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"

	"connectrpc.com/connect"
	"github.com/rs/cors"

	fspb "github.com/circlesac/sandbox/envd/internal/spec/filesystem"
	fsrpc "github.com/circlesac/sandbox/envd/internal/spec/filesystem/filesystemconnect"
	procpb "github.com/circlesac/sandbox/envd/internal/spec/process"
	procrpc "github.com/circlesac/sandbox/envd/internal/spec/process/processconnect"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// ── Global state ──

var (
	envVars     = map[string]string{}
	envMu       sync.RWMutex
	defaultUser = "user"
	pidCounter  atomic.Uint32
)

// ── Main ──

func main() {
	port := flag.Int("port", 49983, "listen port")
	flag.Bool("isnotfc", false, "ignored, compatibility flag")
	flag.Parse()

	mux := http.NewServeMux()

	// REST endpoints
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/init", handleInit)
	mux.HandleFunc("/envs", handleEnvs)
	mux.HandleFunc("/files", handleFiles)

	// connectrpc services
	procPath, procHandler := procrpc.NewProcessHandler(&processService{
		procs: make(map[uint32]*runningProc),
	})
	mux.Handle(procPath, procHandler)

	fsPath, fsHandler := fsrpc.NewFilesystemHandler(&filesystemService{})
	mux.Handle(fsPath, fsHandler)

	handler := cors.New(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{"*"},
		ExposedHeaders: []string{"*"},
	}).Handler(mux)

	addr := fmt.Sprintf("0.0.0.0:%d", *port)
	log.Printf("envd-lite listening on %s", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatal(err)
	}
}

// ── REST handlers ──

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

func handleInit(w http.ResponseWriter, r *http.Request) {
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
	envMu.Lock()
	for k, v := range req.EnvVars {
		envVars[k] = v
	}
	if req.DefaultUser != "" {
		defaultUser = req.DefaultUser
	}
	envMu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func handleEnvs(w http.ResponseWriter, r *http.Request) {
	envMu.RLock()
	defer envMu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(envVars)
}

func handleFiles(w http.ResponseWriter, r *http.Request) {
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
		// E2B SDK uses multipart/form-data with field "file"
		// Following the original envd implementation
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

			// path query param is the target; filename from the part is used if path is a dir
			filePath := path
			if part.FileName() != "" {
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

// ── Process service (connectrpc) ──

type runningProc struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	tag    string
	config *procpb.ProcessConfig
}

type processService struct {
	procrpc.UnimplementedProcessHandler
	mu    sync.Mutex
	procs map[uint32]*runningProc
}

func (s *processService) Start(ctx context.Context, req *connect.Request[procpb.StartRequest], stream *connect.ServerStream[procpb.StartResponse]) error {
	cfg := req.Msg.Process
	if cfg == nil {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("process config required"))
	}

	args := []string{"-l", "-c", buildCmdStr(cfg)}
	cmd := exec.CommandContext(ctx, "/bin/bash", args...)

	if cfg.Cwd != nil {
		cmd.Dir = *cfg.Cwd
	}

	// Set environment
	env := os.Environ()
	envMu.RLock()
	for k, v := range envVars {
		env = append(env, k+"="+v)
	}
	envMu.RUnlock()
	for k, v := range cfg.Envs {
		env = append(env, k+"="+v)
	}
	cmd.Env = env

	stdin, _ := cmd.StdinPipe()
	stdoutR, _ := cmd.StdoutPipe()
	stderrR, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}

	pid := pidCounter.Add(1)
	tag := ""
	if req.Msg.Tag != nil {
		tag = *req.Msg.Tag
	}

	s.mu.Lock()
	s.procs[pid] = &runningProc{cmd: cmd, stdin: stdin, tag: tag, config: cfg}
	s.mu.Unlock()

	// Send start event
	stream.Send(&procpb.StartResponse{
		Event: &procpb.ProcessEvent{
			Event: &procpb.ProcessEvent_Start{
				Start: &procpb.ProcessEvent_StartEvent{Pid: pid},
			},
		},
	})

	// Stream stdout/stderr
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stdoutR.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])
				stream.Send(&procpb.StartResponse{
					Event: &procpb.ProcessEvent{
						Event: &procpb.ProcessEvent_Data{
							Data: &procpb.ProcessEvent_DataEvent{
								Output: &procpb.ProcessEvent_DataEvent_Stdout{Stdout: data},
							},
						},
					},
				})
			}
			if err != nil {
				break
			}
		}
		done <- struct{}{}
	}()

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stderrR.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])
				stream.Send(&procpb.StartResponse{
					Event: &procpb.ProcessEvent{
						Event: &procpb.ProcessEvent_Data{
							Data: &procpb.ProcessEvent_DataEvent{
								Output: &procpb.ProcessEvent_DataEvent_Stderr{Stderr: data},
							},
						},
					},
				})
			}
			if err != nil {
				break
			}
		}
		done <- struct{}{}
	}()

	// Wait for reader goroutines to finish (they'll EOF when process exits)
	<-done
	<-done
	err := cmd.Wait()

	exitCode := int32(0)
	exited := true
	status := "exited"
	var errMsg *string
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = int32(exitErr.ExitCode())
			status = fmt.Sprintf("exit status %d", exitCode)
		} else {
			s := err.Error()
			errMsg = &s
			exited = false
			status = "error"
		}
	}

	stream.Send(&procpb.StartResponse{
		Event: &procpb.ProcessEvent{
			Event: &procpb.ProcessEvent_End{
				End: &procpb.ProcessEvent_EndEvent{
					ExitCode: exitCode,
					Exited:   exited,
					Status:   status,
					Error:    errMsg,
				},
			},
		},
	})

	s.mu.Lock()
	delete(s.procs, pid)
	s.mu.Unlock()

	return nil
}

func (s *processService) List(ctx context.Context, req *connect.Request[procpb.ListRequest]) (*connect.Response[procpb.ListResponse], error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var infos []*procpb.ProcessInfo
	for pid, p := range s.procs {
		info := &procpb.ProcessInfo{
			Pid:    pid,
			Config: p.config,
		}
		if p.tag != "" {
			info.Tag = &p.tag
		}
		infos = append(infos, info)
	}
	return connect.NewResponse(&procpb.ListResponse{Processes: infos}), nil
}

func (s *processService) SendInput(ctx context.Context, req *connect.Request[procpb.SendInputRequest]) (*connect.Response[procpb.SendInputResponse], error) {
	proc := s.getProc(req.Msg.Process)
	if proc == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("process not found"))
	}
	if input := req.Msg.Input; input != nil {
		if stdin := input.GetStdin(); stdin != nil {
			proc.stdin.Write(stdin)
		}
	}
	return connect.NewResponse(&procpb.SendInputResponse{}), nil
}

func (s *processService) SendSignal(ctx context.Context, req *connect.Request[procpb.SendSignalRequest]) (*connect.Response[procpb.SendSignalResponse], error) {
	proc := s.getProc(req.Msg.Process)
	if proc == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("process not found"))
	}
	if proc.cmd.Process != nil {
		sig := syscall.SIGTERM
		if req.Msg.Signal == procpb.Signal_SIGNAL_SIGKILL {
			sig = syscall.SIGKILL
		}
		proc.cmd.Process.Signal(sig)
	}
	return connect.NewResponse(&procpb.SendSignalResponse{}), nil
}

func (s *processService) CloseStdin(ctx context.Context, req *connect.Request[procpb.CloseStdinRequest]) (*connect.Response[procpb.CloseStdinResponse], error) {
	proc := s.getProc(req.Msg.Process)
	if proc == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("process not found"))
	}
	proc.stdin.Close()
	return connect.NewResponse(&procpb.CloseStdinResponse{}), nil
}

func (s *processService) Connect(ctx context.Context, req *connect.Request[procpb.ConnectRequest], stream *connect.ServerStream[procpb.ConnectResponse]) error {
	return connect.NewError(connect.CodeUnimplemented, fmt.Errorf("connect not implemented"))
}

func (s *processService) Update(ctx context.Context, req *connect.Request[procpb.UpdateRequest]) (*connect.Response[procpb.UpdateResponse], error) {
	return connect.NewResponse(&procpb.UpdateResponse{}), nil
}

func (s *processService) StreamInput(ctx context.Context, stream *connect.ClientStream[procpb.StreamInputRequest]) (*connect.Response[procpb.StreamInputResponse], error) {
	return connect.NewResponse(&procpb.StreamInputResponse{}), nil
}

func (s *processService) getProc(sel *procpb.ProcessSelector) *runningProc {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sel == nil {
		return nil
	}
	switch v := sel.Selector.(type) {
	case *procpb.ProcessSelector_Pid:
		return s.procs[v.Pid]
	case *procpb.ProcessSelector_Tag:
		for _, p := range s.procs {
			if p.tag == v.Tag {
				return p
			}
		}
	}
	return nil
}

func buildCmdStr(cfg *procpb.ProcessConfig) string {
	if len(cfg.Args) == 0 {
		return cfg.Cmd
	}
	return cfg.Cmd + " " + strings.Join(cfg.Args, " ")
}

// ── Filesystem service (connectrpc) ──

type filesystemService struct {
	fsrpc.UnimplementedFilesystemHandler
}

func (s *filesystemService) Stat(ctx context.Context, req *connect.Request[fspb.StatRequest]) (*connect.Response[fspb.StatResponse], error) {
	info, err := os.Lstat(req.Msg.Path)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	return connect.NewResponse(&fspb.StatResponse{
		Entry: toEntryInfo(req.Msg.Path, info),
	}), nil
}

func (s *filesystemService) ListDir(ctx context.Context, req *connect.Request[fspb.ListDirRequest]) (*connect.Response[fspb.ListDirResponse], error) {
	entries, err := os.ReadDir(req.Msg.Path)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	var result []*fspb.EntryInfo
	for _, e := range entries {
		info, _ := e.Info()
		if info == nil {
			continue
		}
		result = append(result, toEntryInfo(filepath.Join(req.Msg.Path, e.Name()), info))
	}
	return connect.NewResponse(&fspb.ListDirResponse{Entries: result}), nil
}

func (s *filesystemService) MakeDir(ctx context.Context, req *connect.Request[fspb.MakeDirRequest]) (*connect.Response[fspb.MakeDirResponse], error) {
	if err := os.MkdirAll(req.Msg.Path, 0755); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	info, _ := os.Stat(req.Msg.Path)
	return connect.NewResponse(&fspb.MakeDirResponse{
		Entry: toEntryInfo(req.Msg.Path, info),
	}), nil
}

func (s *filesystemService) Remove(ctx context.Context, req *connect.Request[fspb.RemoveRequest]) (*connect.Response[fspb.RemoveResponse], error) {
	if err := os.RemoveAll(req.Msg.Path); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&fspb.RemoveResponse{}), nil
}

func (s *filesystemService) Move(ctx context.Context, req *connect.Request[fspb.MoveRequest]) (*connect.Response[fspb.MoveResponse], error) {
	if err := os.Rename(req.Msg.Source, req.Msg.Destination); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	info, _ := os.Stat(req.Msg.Destination)
	return connect.NewResponse(&fspb.MoveResponse{
		Entry: toEntryInfo(req.Msg.Destination, info),
	}), nil
}

func (s *filesystemService) WatchDir(ctx context.Context, req *connect.Request[fspb.WatchDirRequest], stream *connect.ServerStream[fspb.WatchDirResponse]) error {
	return connect.NewError(connect.CodeUnimplemented, fmt.Errorf("watchdir not implemented"))
}

func (s *filesystemService) CreateWatcher(ctx context.Context, req *connect.Request[fspb.CreateWatcherRequest]) (*connect.Response[fspb.CreateWatcherResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("not implemented"))
}

func (s *filesystemService) GetWatcherEvents(ctx context.Context, req *connect.Request[fspb.GetWatcherEventsRequest]) (*connect.Response[fspb.GetWatcherEventsResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("not implemented"))
}

func (s *filesystemService) RemoveWatcher(ctx context.Context, req *connect.Request[fspb.RemoveWatcherRequest]) (*connect.Response[fspb.RemoveWatcherResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("not implemented"))
}

func toEntryInfo(path string, info os.FileInfo) *fspb.EntryInfo {
	if info == nil {
		return &fspb.EntryInfo{Path: path, Name: filepath.Base(path)}
	}
	ft := fspb.FileType_FILE_TYPE_FILE
	if info.IsDir() {
		ft = fspb.FileType_FILE_TYPE_DIRECTORY
	} else if info.Mode()&os.ModeSymlink != 0 {
		ft = fspb.FileType_FILE_TYPE_SYMLINK
	}

	entry := &fspb.EntryInfo{
		Name:         info.Name(),
		Type:         ft,
		Path:         path,
		Size:         info.Size(),
		Mode:         uint32(info.Mode().Perm()),
		Permissions:  info.Mode().Perm().String(),
		ModifiedTime: timestamppb.New(info.ModTime()),
	}

	if ft == fspb.FileType_FILE_TYPE_SYMLINK {
		if target, err := os.Readlink(path); err == nil {
			entry.SymlinkTarget = &target
		}
	}

	return entry
}
