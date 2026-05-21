package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/fsnotify/fsnotify"

	fspb "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen/filesystem"
	fsrpc "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen/filesystem/filesystemconnect"
)

func translateFSEventForTest(op uint32, name string) *fspb.FilesystemEvent {
	return translateEvent(fsnotify.Event{Name: name, Op: fsnotify.Op(op)})
}

func newFilesystemTestServer(t *testing.T) (fsrpc.FilesystemClient, *FilesystemService, func()) {
	t.Helper()
	svc := NewFilesystemService()
	mux := http.NewServeMux()
	path, handler := fsrpc.NewFilesystemHandler(svc)
	mux.Handle(path, handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	client := fsrpc.NewFilesystemClient(srv.Client(), srv.URL, connect.WithGRPC())
	return client, svc, srv.Close
}

func TestFS_StatListMakeMoveRemove(t *testing.T) {
	client, _, stop := newFilesystemTestServer(t)
	defer stop()

	dir := t.TempDir()
	a := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(a, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	// Stat.
	stat, err := client.Stat(context.Background(), connect.NewRequest(&fspb.StatRequest{Path: a}))
	if err != nil {
		t.Fatal(err)
	}
	if stat.Msg.Entry.Size != 5 {
		t.Errorf("size=%d", stat.Msg.Entry.Size)
	}
	if stat.Msg.Entry.Type != fspb.FileType_FILE_TYPE_FILE {
		t.Errorf("type=%v", stat.Msg.Entry.Type)
	}

	// ListDir.
	listed, err := client.ListDir(context.Background(), connect.NewRequest(&fspb.ListDirRequest{Path: dir}))
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Msg.Entries) != 1 {
		t.Errorf("entries=%d", len(listed.Msg.Entries))
	}

	// MakeDir.
	sub := filepath.Join(dir, "sub")
	mkdir, err := client.MakeDir(context.Background(), connect.NewRequest(&fspb.MakeDirRequest{Path: sub}))
	if err != nil {
		t.Fatal(err)
	}
	if mkdir.Msg.Entry.Type != fspb.FileType_FILE_TYPE_DIRECTORY {
		t.Errorf("not dir: %v", mkdir.Msg.Entry.Type)
	}

	// Move.
	b := filepath.Join(dir, "b.txt")
	if _, err := client.Move(context.Background(), connect.NewRequest(&fspb.MoveRequest{Source: a, Destination: b})); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(b); err != nil {
		t.Errorf("b missing: %v", err)
	}

	// Remove.
	if _, err := client.Remove(context.Background(), connect.NewRequest(&fspb.RemoveRequest{Path: b})); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(b); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("b still present: %v", err)
	}
}

func TestFS_Stat_NotFound(t *testing.T) {
	client, _, stop := newFilesystemTestServer(t)
	defer stop()

	_, err := client.Stat(context.Background(), connect.NewRequest(&fspb.StatRequest{Path: "/nope/nope"}))
	if err == nil {
		t.Fatal("expected error")
	}
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeNotFound {
		t.Errorf("want NotFound, got %v", err)
	}
}

func TestFS_Symlink(t *testing.T) {
	client, _, stop := newFilesystemTestServer(t)
	defer stop()

	dir := t.TempDir()
	target := filepath.Join(dir, "real")
	if err := os.WriteFile(target, []byte("ok"), 0644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	stat, err := client.Stat(context.Background(), connect.NewRequest(&fspb.StatRequest{Path: link}))
	if err != nil {
		t.Fatal(err)
	}
	if stat.Msg.Entry.Type != fspb.FileType_FILE_TYPE_SYMLINK {
		t.Errorf("type=%v", stat.Msg.Entry.Type)
	}
	if stat.Msg.Entry.SymlinkTarget == nil || *stat.Msg.Entry.SymlinkTarget != target {
		t.Errorf("target=%v", stat.Msg.Entry.SymlinkTarget)
	}
}

func TestFS_WatchDir_Stream(t *testing.T) {
	client, _, stop := newFilesystemTestServer(t)
	defer stop()

	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stream, err := client.WatchDir(ctx, connect.NewRequest(&fspb.WatchDirRequest{Path: dir}))
	if err != nil {
		t.Fatal(err)
	}

	// First event should be Start.
	if !stream.Receive() {
		t.Fatalf("no start: %v", stream.Err())
	}
	if _, ok := stream.Msg().Event.(*fspb.WatchDirResponse_Start); !ok {
		t.Errorf("first event not start: %T", stream.Msg().Event)
	}

	go func() {
		time.Sleep(150 * time.Millisecond)
		os.WriteFile(filepath.Join(dir, "new.txt"), []byte("x"), 0644)
	}()

	var gotCreate bool
	for stream.Receive() {
		ev := stream.Msg().Event
		if fe, ok := ev.(*fspb.WatchDirResponse_Filesystem); ok {
			if fe.Filesystem.Type == fspb.EventType_EVENT_TYPE_CREATE {
				gotCreate = true
				break
			}
		}
	}
	cancel()
	if !gotCreate {
		t.Errorf("never saw create event")
	}
}

func TestFS_WatchDir_Recursive(t *testing.T) {
	client, _, stop := newFilesystemTestServer(t)
	defer stop()

	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stream, err := client.WatchDir(ctx, connect.NewRequest(&fspb.WatchDirRequest{Path: dir, Recursive: true}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() {
		t.Fatalf("no start: %v", stream.Err())
	}

	go func() {
		time.Sleep(200 * time.Millisecond)
		os.WriteFile(filepath.Join(sub, "child.txt"), []byte("y"), 0644)
	}()

	var saw bool
	for stream.Receive() {
		ev := stream.Msg().Event
		if fe, ok := ev.(*fspb.WatchDirResponse_Filesystem); ok {
			if filepath.Base(fe.Filesystem.Name) == "child.txt" {
				saw = true
				break
			}
		}
	}
	cancel()
	if !saw {
		t.Errorf("recursive watcher didn't see child event")
	}
}

func TestFS_CreateWatcher_Polled(t *testing.T) {
	client, _, stop := newFilesystemTestServer(t)
	defer stop()

	dir := t.TempDir()
	resp, err := client.CreateWatcher(context.Background(), connect.NewRequest(&fspb.CreateWatcherRequest{Path: dir}))
	if err != nil {
		t.Fatal(err)
	}
	id := resp.Msg.WatcherId
	if id == "" {
		t.Fatal("empty watcher id")
	}

	time.Sleep(100 * time.Millisecond)
	if err := os.WriteFile(filepath.Join(dir, "polled.txt"), []byte("z"), 0644); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(3 * time.Second)
	var sawCreate bool
	for time.Now().Before(deadline) {
		ev, err := client.GetWatcherEvents(context.Background(), connect.NewRequest(&fspb.GetWatcherEventsRequest{WatcherId: id}))
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range ev.Msg.Events {
			if e.Type == fspb.EventType_EVENT_TYPE_CREATE && filepath.Base(e.Name) == "polled.txt" {
				sawCreate = true
			}
		}
		if sawCreate {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !sawCreate {
		t.Errorf("polled watcher missed create")
	}

	if _, err := client.RemoveWatcher(context.Background(), connect.NewRequest(&fspb.RemoveWatcherRequest{WatcherId: id})); err != nil {
		t.Fatal(err)
	}

	if _, err := client.GetWatcherEvents(context.Background(), connect.NewRequest(&fspb.GetWatcherEventsRequest{WatcherId: id})); err == nil {
		t.Error("expected NotFound after remove")
	}

	if _, err := client.RemoveWatcher(context.Background(), connect.NewRequest(&fspb.RemoveWatcherRequest{WatcherId: id})); err == nil {
		t.Error("expected NotFound on double-remove")
	}
}

func TestFS_CreateWatcher_BadPath(t *testing.T) {
	client, _, stop := newFilesystemTestServer(t)
	defer stop()
	_, err := client.CreateWatcher(context.Background(), connect.NewRequest(&fspb.CreateWatcherRequest{Path: "/nonexistent/abc/def"}))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestFS_GetWatcherEvents_Unknown(t *testing.T) {
	client, _, stop := newFilesystemTestServer(t)
	defer stop()
	_, err := client.GetWatcherEvents(context.Background(), connect.NewRequest(&fspb.GetWatcherEventsRequest{WatcherId: "deadbeef"}))
	if err == nil {
		t.Fatal("expected NotFound")
	}
}

func TestFS_ListDir_NotFound(t *testing.T) {
	client, _, stop := newFilesystemTestServer(t)
	defer stop()
	_, err := client.ListDir(context.Background(), connect.NewRequest(&fspb.ListDirRequest{Path: "/no/such/dir"}))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestFS_TranslateEvent(t *testing.T) {
	cases := []struct {
		op   uint32
		want fspb.EventType
	}{
		{1, fspb.EventType_EVENT_TYPE_CREATE}, // fsnotify.Create
		{2, fspb.EventType_EVENT_TYPE_WRITE},  // fsnotify.Write
		{4, fspb.EventType_EVENT_TYPE_REMOVE},
		{8, fspb.EventType_EVENT_TYPE_RENAME},
		{16, fspb.EventType_EVENT_TYPE_CHMOD},
	}
	for _, c := range cases {
		ev := translateFSEventForTest(c.op, "/tmp/x")
		if ev == nil || ev.Type != c.want {
			t.Errorf("op=%d → %v (want %v)", c.op, ev, c.want)
		}
	}
	if translateFSEventForTest(0, "/tmp/x") != nil {
		t.Errorf("op=0 should return nil")
	}
}

func TestFS_WatchDir_EmitsEventForUpdate(t *testing.T) {
	client, _, stop := newFilesystemTestServer(t)
	defer stop()

	dir := t.TempDir()
	target := filepath.Join(dir, "u.txt")
	os.WriteFile(target, []byte("v1"), 0644)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	stream, err := client.WatchDir(ctx, connect.NewRequest(&fspb.WatchDirRequest{Path: dir}))
	if err != nil {
		t.Fatal(err)
	}
	stream.Receive() // start

	go func() {
		time.Sleep(150 * time.Millisecond)
		os.WriteFile(target, []byte("v2"), 0644)
	}()

	var sawWrite bool
	for stream.Receive() {
		if fe, ok := stream.Msg().Event.(*fspb.WatchDirResponse_Filesystem); ok {
			if fe.Filesystem.Type == fspb.EventType_EVENT_TYPE_WRITE {
				sawWrite = true
				break
			}
		}
	}
	if !sawWrite {
		t.Errorf("never saw write event")
	}
}

func TestFS_Remove_NotFound(t *testing.T) {
	client, _, stop := newFilesystemTestServer(t)
	defer stop()
	// Remove of non-existent path uses RemoveAll which returns nil.
	if _, err := client.Remove(context.Background(), connect.NewRequest(&fspb.RemoveRequest{Path: "/no/such/path/9999"})); err != nil {
		t.Fatal(err)
	}
}
