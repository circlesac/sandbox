package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/fsnotify/fsnotify"
	"golang.org/x/sys/unix"
	"google.golang.org/protobuf/types/known/timestamppb"

	fspb "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-runtime/gen/filesystem"
	fsrpc "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-runtime/gen/filesystem/filesystemconnect"
)

// watcherBufferCap bounds the events held per polled watcher to keep memory
// bounded if the caller never polls. Overflow drops oldest events.
const watcherBufferCap = 4096

type watcher struct {
	w            *fsnotify.Watcher
	recursive    bool
	includeEntry bool
	root         string

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

// WatchDir streams events. allow_network_mounts needs no handling: fsnotify
// watches any mounted path, with whatever reliability the filesystem gives.
func (s *FilesystemService) WatchDir(ctx context.Context, req *connect.Request[fspb.WatchDirRequest], stream *connect.ServerStream[fspb.WatchDirResponse]) error {
	w, err := newFSWatcher(req.Msg.Path, req.Msg.Recursive)
	if err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}
	w.includeEntry = req.Msg.IncludeEntry
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
			fe = withEntry(fe, w.includeEntry)
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
	w.includeEntry = req.Msg.IncludeEntry

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
			fe = withEntry(fe, w.includeEntry)
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

// toEntryInfo describes an entry from its Lstat info the way upstream envd
// does: for a symlink, IsSymlink is set and Type and Mode describe the target
// (unspecified when the link dangles); Permissions keeps the type letter.
func toEntryInfo(path string, info os.FileInfo) *fspb.EntryInfo {
	if info == nil {
		return &fspb.EntryInfo{Path: path, Name: filepath.Base(path)}
	}
	isSymlink := info.Mode()&os.ModeSymlink != 0
	ft, mode := entryType(info.Mode()), info.Mode().Perm()
	if isSymlink {
		ft, mode = fspb.FileType_FILE_TYPE_UNSPECIFIED, 0
		if target, err := os.Stat(path); err == nil {
			ft, mode = entryType(target.Mode()), target.Mode().Perm()
		}
	}

	entry := &fspb.EntryInfo{
		Name:         info.Name(),
		Type:         ft,
		Path:         path,
		Size:         info.Size(),
		Mode:         uint32(mode),
		Permissions:  info.Mode().String(),
		ModifiedTime: timestamppb.New(info.ModTime()),
		IsSymlink:    isSymlink,
		Metadata:     readMetadata(path),
	}

	if isSymlink {
		if target, err := os.Readlink(path); err == nil {
			entry.SymlinkTarget = &target
		}
	}

	return entry
}

func entryType(mode os.FileMode) fspb.FileType {
	switch {
	case mode.IsDir():
		return fspb.FileType_FILE_TYPE_DIRECTORY
	case mode.IsRegular():
		return fspb.FileType_FILE_TYPE_FILE
	case mode&os.ModeSymlink != 0:
		return fspb.FileType_FILE_TYPE_SYMLINK
	default:
		return fspb.FileType_FILE_TYPE_UNSPECIFIED
	}
}

// metadataPrefix is the xattr namespace upstream envd keeps file metadata in.
const metadataPrefix = "user.e2b."

// readMetadata returns the entry's user.e2b.* extended attributes, prefix stripped.
func readMetadata(path string) map[string]string {
	size, err := unix.Llistxattr(path, nil)
	if err != nil || size <= 0 {
		return nil
	}
	buf := make([]byte, size)
	size, err = unix.Llistxattr(path, buf)
	if err != nil {
		return nil
	}
	var metadata map[string]string
	for _, name := range strings.Split(string(buf[:size]), "\x00") {
		if !strings.HasPrefix(name, metadataPrefix) {
			continue
		}
		value := make([]byte, 4096)
		n, err := unix.Lgetxattr(path, name, value)
		if err != nil {
			continue
		}
		if metadata == nil {
			metadata = map[string]string{}
		}
		metadata[strings.TrimPrefix(name, metadataPrefix)] = string(value[:n])
	}
	return metadata
}

// withEntry attaches the affected entry when the caller asked for it. Like
// upstream envd, only create, write, and chmod events carry one: after a
// remove or rename the path no longer holds the original entry.
func withEntry(fe *fspb.FilesystemEvent, includeEntry bool) *fspb.FilesystemEvent {
	if !includeEntry {
		return fe
	}
	switch fe.Type {
	case fspb.EventType_EVENT_TYPE_CREATE, fspb.EventType_EVENT_TYPE_WRITE, fspb.EventType_EVENT_TYPE_CHMOD:
		if info, err := os.Lstat(fe.Name); err == nil {
			fe.Entry = toEntryInfo(fe.Name, info)
		}
	}
	return fe
}
