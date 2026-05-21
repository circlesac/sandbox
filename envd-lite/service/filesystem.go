package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/fsnotify/fsnotify"
	"google.golang.org/protobuf/types/known/timestamppb"

	fspb "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen/filesystem"
	fsrpc "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen/filesystem/filesystemconnect"
)

// watcherBufferCap bounds the events held per polled watcher to keep memory
// bounded if the caller never polls. Overflow drops oldest events.
const watcherBufferCap = 4096

type watcher struct {
	w         *fsnotify.Watcher
	recursive bool
	root      string

	mu     sync.Mutex
	buffer []*fspb.FilesystemEvent

	stop chan struct{}
	once sync.Once
}

func (w *watcher) close() {
	w.once.Do(func() {
		close(w.stop)
		w.w.Close()
	})
}

type FilesystemService struct {
	fsrpc.UnimplementedFilesystemHandler

	mu       sync.Mutex
	watchers map[string]*watcher
}

func NewFilesystemService() *FilesystemService {
	return &FilesystemService{
		watchers: make(map[string]*watcher),
	}
}

func (s *FilesystemService) Stat(ctx context.Context, req *connect.Request[fspb.StatRequest]) (*connect.Response[fspb.StatResponse], error) {
	info, err := os.Lstat(req.Msg.Path)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	return connect.NewResponse(&fspb.StatResponse{
		Entry: toEntryInfo(req.Msg.Path, info),
	}), nil
}

func (s *FilesystemService) ListDir(ctx context.Context, req *connect.Request[fspb.ListDirRequest]) (*connect.Response[fspb.ListDirResponse], error) {
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

func (s *FilesystemService) MakeDir(ctx context.Context, req *connect.Request[fspb.MakeDirRequest]) (*connect.Response[fspb.MakeDirResponse], error) {
	if err := os.MkdirAll(req.Msg.Path, 0755); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	info, _ := os.Stat(req.Msg.Path)
	return connect.NewResponse(&fspb.MakeDirResponse{
		Entry: toEntryInfo(req.Msg.Path, info),
	}), nil
}

func (s *FilesystemService) Remove(ctx context.Context, req *connect.Request[fspb.RemoveRequest]) (*connect.Response[fspb.RemoveResponse], error) {
	if err := os.RemoveAll(req.Msg.Path); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&fspb.RemoveResponse{}), nil
}

func (s *FilesystemService) Move(ctx context.Context, req *connect.Request[fspb.MoveRequest]) (*connect.Response[fspb.MoveResponse], error) {
	if err := os.Rename(req.Msg.Source, req.Msg.Destination); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	info, _ := os.Stat(req.Msg.Destination)
	return connect.NewResponse(&fspb.MoveResponse{
		Entry: toEntryInfo(req.Msg.Destination, info),
	}), nil
}

func (s *FilesystemService) WatchDir(ctx context.Context, req *connect.Request[fspb.WatchDirRequest], stream *connect.ServerStream[fspb.WatchDirResponse]) error {
	w, err := newFSWatcher(req.Msg.Path, req.Msg.Recursive)
	if err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}
	defer w.close()

	if err := stream.Send(&fspb.WatchDirResponse{
		Event: &fspb.WatchDirResponse_Start{Start: &fspb.WatchDirResponse_StartEvent{}},
	}); err != nil {
		return err
	}

	ka := time.NewTicker(30 * time.Second)
	defer ka.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case ev, ok := <-w.w.Events:
			if !ok {
				return nil
			}
			fe := translateEvent(ev)
			if fe == nil {
				continue
			}
			if w.recursive && ev.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
					w.w.Add(ev.Name)
				}
			}
			if err := stream.Send(&fspb.WatchDirResponse{
				Event: &fspb.WatchDirResponse_Filesystem{Filesystem: fe},
			}); err != nil {
				return err
			}
		case err, ok := <-w.w.Errors:
			if !ok {
				return nil
			}
			return connect.NewError(connect.CodeInternal, err)
		case <-ka.C:
			if err := stream.Send(&fspb.WatchDirResponse{
				Event: &fspb.WatchDirResponse_Keepalive{Keepalive: &fspb.WatchDirResponse_KeepAlive{}},
			}); err != nil {
				return err
			}
		}
	}
}

func (s *FilesystemService) CreateWatcher(ctx context.Context, req *connect.Request[fspb.CreateWatcherRequest]) (*connect.Response[fspb.CreateWatcherResponse], error) {
	w, err := newFSWatcher(req.Msg.Path, req.Msg.Recursive)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	id := newWatcherID()
	s.mu.Lock()
	s.watchers[id] = w
	s.mu.Unlock()

	go s.drainPolled(w)

	return connect.NewResponse(&fspb.CreateWatcherResponse{WatcherId: id}), nil
}

func (s *FilesystemService) GetWatcherEvents(ctx context.Context, req *connect.Request[fspb.GetWatcherEventsRequest]) (*connect.Response[fspb.GetWatcherEventsResponse], error) {
	s.mu.Lock()
	w, ok := s.watchers[req.Msg.WatcherId]
	s.mu.Unlock()
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("watcher not found"))
	}

	w.mu.Lock()
	events := w.buffer
	w.buffer = nil
	w.mu.Unlock()

	return connect.NewResponse(&fspb.GetWatcherEventsResponse{Events: events}), nil
}

func (s *FilesystemService) RemoveWatcher(ctx context.Context, req *connect.Request[fspb.RemoveWatcherRequest]) (*connect.Response[fspb.RemoveWatcherResponse], error) {
	s.mu.Lock()
	w, ok := s.watchers[req.Msg.WatcherId]
	if ok {
		delete(s.watchers, req.Msg.WatcherId)
	}
	s.mu.Unlock()
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("watcher not found"))
	}
	w.close()
	return connect.NewResponse(&fspb.RemoveWatcherResponse{}), nil
}

func (s *FilesystemService) drainPolled(w *watcher) {
	for {
		select {
		case <-w.stop:
			return
		case ev, ok := <-w.w.Events:
			if !ok {
				return
			}
			fe := translateEvent(ev)
			if fe == nil {
				continue
			}
			if w.recursive && ev.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
					w.w.Add(ev.Name)
				}
			}
			w.mu.Lock()
			w.buffer = append(w.buffer, fe)
			if len(w.buffer) > watcherBufferCap {
				w.buffer = w.buffer[len(w.buffer)-watcherBufferCap:]
			}
			w.mu.Unlock()
		case _, ok := <-w.w.Errors:
			if !ok {
				return
			}
		}
	}
}

func newFSWatcher(root string, recursive bool) (*watcher, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	if err := fw.Add(root); err != nil {
		fw.Close()
		return nil, err
	}
	if recursive {
		filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
			if err != nil || info == nil || !info.IsDir() || p == root {
				return nil
			}
			fw.Add(p)
			return nil
		})
	}
	return &watcher{
		w:         fw,
		recursive: recursive,
		root:      root,
		stop:      make(chan struct{}),
	}, nil
}

func translateEvent(ev fsnotify.Event) *fspb.FilesystemEvent {
	switch {
	case ev.Op&fsnotify.Create != 0:
		return &fspb.FilesystemEvent{Name: ev.Name, Type: fspb.EventType_EVENT_TYPE_CREATE}
	case ev.Op&fsnotify.Write != 0:
		return &fspb.FilesystemEvent{Name: ev.Name, Type: fspb.EventType_EVENT_TYPE_WRITE}
	case ev.Op&fsnotify.Remove != 0:
		return &fspb.FilesystemEvent{Name: ev.Name, Type: fspb.EventType_EVENT_TYPE_REMOVE}
	case ev.Op&fsnotify.Rename != 0:
		return &fspb.FilesystemEvent{Name: ev.Name, Type: fspb.EventType_EVENT_TYPE_RENAME}
	case ev.Op&fsnotify.Chmod != 0:
		return &fspb.FilesystemEvent{Name: ev.Name, Type: fspb.EventType_EVENT_TYPE_CHMOD}
	}
	return nil
}

func newWatcherID() string {
	var buf [12]byte
	rand.Read(buf[:])
	return hex.EncodeToString(buf[:])
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
