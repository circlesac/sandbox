package service

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	procpb "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen/process"
	procrpc "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen/process/processconnect"
)

func newProcessTestServer(t *testing.T) (procrpc.ProcessClient, *ProcessService, func()) {
	t.Helper()
	svc := NewProcessService(func() []string { return []string{"PATH=" + getPath()} })
	mux := http.NewServeMux()
	path, handler := procrpc.NewProcessHandler(svc)
	mux.Handle(path, handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()

	client := procrpc.NewProcessClient(srv.Client(), srv.URL, connect.WithGRPC())
	return client, svc, srv.Close
}

func getPath() string {
	return "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
}

func collectStart(t *testing.T, stream *connect.ServerStreamForClient[procpb.StartResponse]) (events []*procpb.ProcessEvent, err error) {
	t.Helper()
	for stream.Receive() {
		events = append(events, stream.Msg().Event)
	}
	return events, stream.Err()
}

func TestStart_BasicExit(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	stream, err := client.Start(context.Background(), connect.NewRequest(&procpb.StartRequest{
		Process: &procpb.ProcessConfig{Cmd: "/bin/sh", Args: []string{"-c", "echo hello"}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectStart(t, stream)
	if err != nil {
		t.Fatal(err)
	}

	if len(events) < 3 {
		t.Fatalf("expected start + data + end events, got %d", len(events))
	}
	if _, ok := events[0].Event.(*procpb.ProcessEvent_Start); !ok {
		t.Errorf("first event not Start: %T", events[0].Event)
	}

	var stdout strings.Builder
	var end *procpb.ProcessEvent_EndEvent
	for _, ev := range events {
		switch e := ev.Event.(type) {
		case *procpb.ProcessEvent_Data:
			if s, ok := e.Data.Output.(*procpb.ProcessEvent_DataEvent_Stdout); ok {
				stdout.Write(s.Stdout)
			}
		case *procpb.ProcessEvent_End:
			end = e.End
		}
	}
	if !strings.Contains(stdout.String(), "hello") {
		t.Errorf("stdout missing 'hello': %q", stdout.String())
	}
	if end == nil {
		t.Fatal("no end event")
	}
	if end.ExitCode != 0 {
		t.Errorf("exit=%d", end.ExitCode)
	}
}

func TestStart_StreamingChunks(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	// Two writes separated by sleep so they cannot coalesce into one chunk.
	script := `printf 'A'; sleep 0.25; printf 'B'`
	stream, err := client.Start(context.Background(), connect.NewRequest(&procpb.StartRequest{
		Process: &procpb.ProcessConfig{Cmd: "/bin/sh", Args: []string{"-c", script}},
	}))
	if err != nil {
		t.Fatal(err)
	}

	var firstChunkAt, secondChunkAt time.Time
	chunks := 0
	for stream.Receive() {
		ev := stream.Msg().Event
		if d, ok := ev.Event.(*procpb.ProcessEvent_Data); ok {
			if s, ok := d.Data.Output.(*procpb.ProcessEvent_DataEvent_Stdout); ok && len(s.Stdout) > 0 {
				chunks++
				if chunks == 1 {
					firstChunkAt = time.Now()
				} else if chunks == 2 {
					secondChunkAt = time.Now()
				}
			}
		}
	}
	if err := stream.Err(); err != nil {
		t.Fatal(err)
	}
	if chunks < 2 {
		t.Fatalf("expected >=2 chunks (streamed), got %d", chunks)
	}
	if dt := secondChunkAt.Sub(firstChunkAt); dt < 100*time.Millisecond {
		t.Errorf("chunks arrived too close (%s) — likely buffered, not streamed", dt)
	}
}

func TestStart_Stderr(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	stream, err := client.Start(context.Background(), connect.NewRequest(&procpb.StartRequest{
		Process: &procpb.ProcessConfig{Cmd: "/bin/sh", Args: []string{"-c", "echo oops 1>&2; exit 3"}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	events, _ := collectStart(t, stream)

	var stderr strings.Builder
	var exit int32 = -1
	for _, ev := range events {
		switch e := ev.Event.(type) {
		case *procpb.ProcessEvent_Data:
			if s, ok := e.Data.Output.(*procpb.ProcessEvent_DataEvent_Stderr); ok {
				stderr.Write(s.Stderr)
			}
		case *procpb.ProcessEvent_End:
			exit = e.End.ExitCode
		}
	}
	if !strings.Contains(stderr.String(), "oops") {
		t.Errorf("stderr missing 'oops': %q", stderr.String())
	}
	if exit != 3 {
		t.Errorf("exit=%d want 3", exit)
	}
}

func TestStart_MissingProcessConfig(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	stream, err := client.Start(context.Background(), connect.NewRequest(&procpb.StartRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = collectStart(t, stream)
	if err == nil {
		t.Fatal("expected error for missing process config")
	}
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeInvalidArgument {
		t.Errorf("want InvalidArgument, got %v", err)
	}
}

func TestConnect_ReattachAndReplay(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	startCtx, startCancel := context.WithCancel(context.Background())
	defer startCancel()

	script := `printf 'AAA'; sleep 0.6; printf 'BBB'; sleep 0.6; printf 'CCC'`
	startStream, err := client.Start(startCtx, connect.NewRequest(&procpb.StartRequest{
		Process: &procpb.ProcessConfig{Cmd: "/bin/sh", Args: []string{"-c", script}},
	}))
	if err != nil {
		t.Fatal(err)
	}

	if !startStream.Receive() {
		t.Fatalf("no events: %v", startStream.Err())
	}
	startEv, ok := startStream.Msg().Event.Event.(*procpb.ProcessEvent_Start)
	if !ok {
		t.Fatalf("first not StartEvent: %T", startStream.Msg().Event.Event)
	}
	pid := startEv.Start.Pid

	// Wait until first chunk so the replay buffer has data, then start Connect.
	if !startStream.Receive() {
		t.Fatalf("no first data: %v", startStream.Err())
	}

	connStream, err := client.Connect(context.Background(), connect.NewRequest(&procpb.ConnectRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: pid}},
	}))
	if err != nil {
		t.Fatal(err)
	}

	var collected strings.Builder
	done := make(chan struct{})
	go func() {
		defer close(done)
		for connStream.Receive() {
			ev := connStream.Msg().Event
			if d, ok := ev.Event.(*procpb.ProcessEvent_Data); ok {
				if s, ok := d.Data.Output.(*procpb.ProcessEvent_DataEvent_Stdout); ok {
					collected.Write(s.Stdout)
				}
			}
			if _, end := ev.Event.(*procpb.ProcessEvent_End); end {
				return
			}
		}
	}()

	// Drain Start stream so the process can finish.
	go func() {
		for startStream.Receive() {
		}
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("connect stream didn't finish")
	}

	got := collected.String()
	if !strings.Contains(got, "AAA") || !strings.Contains(got, "BBB") || !strings.Contains(got, "CCC") {
		t.Errorf("connect stream missed output: %q", got)
	}
}

func TestConnect_AfterExit(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	stream, err := client.Start(context.Background(), connect.NewRequest(&procpb.StartRequest{
		Process: &procpb.ProcessConfig{Cmd: "/bin/sh", Args: []string{"-c", "printf 'fin'"}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() {
		t.Fatalf("no start: %v", stream.Err())
	}
	pid := stream.Msg().Event.Event.(*procpb.ProcessEvent_Start).Start.Pid

	// Drain.
	for stream.Receive() {
	}
	if err := stream.Err(); err != nil {
		t.Fatal(err)
	}

	// Connect after exit: should still get start + replayed data + end via linger.
	connStream, err := client.Connect(context.Background(), connect.NewRequest(&procpb.ConnectRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: pid}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	var sawEnd bool
	for connStream.Receive() {
		ev := connStream.Msg().Event
		if d, ok := ev.Event.(*procpb.ProcessEvent_Data); ok {
			if s, ok := d.Data.Output.(*procpb.ProcessEvent_DataEvent_Stdout); ok {
				out.Write(s.Stdout)
			}
		}
		if _, ok := ev.Event.(*procpb.ProcessEvent_End); ok {
			sawEnd = true
		}
	}
	if err := connStream.Err(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "fin") {
		t.Errorf("missed replay: %q", out.String())
	}
	if !sawEnd {
		t.Errorf("no end event in connect-after-exit")
	}
}

func TestConnect_NotFound(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	stream, err := client.Connect(context.Background(), connect.NewRequest(&procpb.ConnectRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: 99999}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = func() ([]*procpb.ProcessEvent, error) {
		var events []*procpb.ProcessEvent
		for stream.Receive() {
			events = append(events, stream.Msg().Event)
		}
		return events, stream.Err()
	}()
	if err == nil {
		t.Fatal("expected NotFound")
	}
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeNotFound {
		t.Errorf("want NotFound, got %v", err)
	}
}

func TestSendInput_Stdin(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	stream, err := client.Start(context.Background(), connect.NewRequest(&procpb.StartRequest{
		Process: &procpb.ProcessConfig{Cmd: "/bin/cat"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() {
		t.Fatalf("no start: %v", stream.Err())
	}
	startEv := stream.Msg().Event.Event.(*procpb.ProcessEvent_Start)
	pid := startEv.Start.Pid

	_, err = client.SendInput(context.Background(), connect.NewRequest(&procpb.SendInputRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: pid}},
		Input: &procpb.ProcessInput{
			Input: &procpb.ProcessInput_Stdin{Stdin: []byte("hi\n")},
		},
	}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.CloseStdin(context.Background(), connect.NewRequest(&procpb.CloseStdinRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: pid}},
	}))
	if err != nil {
		t.Fatal(err)
	}

	var out strings.Builder
	for stream.Receive() {
		ev := stream.Msg().Event
		if d, ok := ev.Event.(*procpb.ProcessEvent_Data); ok {
			if s, ok := d.Data.Output.(*procpb.ProcessEvent_DataEvent_Stdout); ok {
				out.Write(s.Stdout)
			}
		}
	}
	if !strings.Contains(out.String(), "hi") {
		t.Errorf("echo missed input: %q", out.String())
	}
}

func TestSendSignal_SIGKILL(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	stream, err := client.Start(context.Background(), connect.NewRequest(&procpb.StartRequest{
		Process: &procpb.ProcessConfig{Cmd: "/bin/sh", Args: []string{"-c", "sleep 30"}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() {
		t.Fatalf("no start: %v", stream.Err())
	}
	pid := stream.Msg().Event.Event.(*procpb.ProcessEvent_Start).Start.Pid

	time.Sleep(100 * time.Millisecond)
	_, err = client.SendSignal(context.Background(), connect.NewRequest(&procpb.SendSignalRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: pid}},
		Signal:  procpb.Signal_SIGNAL_SIGKILL,
	}))
	if err != nil {
		t.Fatal(err)
	}

	var end *procpb.ProcessEvent_EndEvent
	for stream.Receive() {
		if e, ok := stream.Msg().Event.Event.(*procpb.ProcessEvent_End); ok {
			end = e.End
		}
	}
	if end == nil {
		t.Fatal("no end event after kill")
	}
	if !strings.Contains(end.Status, "signal") && end.ExitCode == 0 {
		t.Errorf("expected signal status, got %q (exit=%d)", end.Status, end.ExitCode)
	}
}

func TestList(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	tag := "mytag"
	stream, err := client.Start(context.Background(), connect.NewRequest(&procpb.StartRequest{
		Process: &procpb.ProcessConfig{Cmd: "/bin/sh", Args: []string{"-c", "sleep 5"}},
		Tag:     &tag,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() {
		t.Fatalf("no start: %v", stream.Err())
	}
	pid := stream.Msg().Event.Event.(*procpb.ProcessEvent_Start).Start.Pid

	time.Sleep(50 * time.Millisecond)
	resp, err := client.List(context.Background(), connect.NewRequest(&procpb.ListRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range resp.Msg.Processes {
		if p.Pid == pid {
			found = true
			if p.Tag == nil || *p.Tag != tag {
				t.Errorf("tag missing: %+v", p.Tag)
			}
		}
	}
	if !found {
		t.Errorf("process not in list")
	}

	// Cleanup.
	client.SendSignal(context.Background(), connect.NewRequest(&procpb.SendSignalRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: pid}},
		Signal:  procpb.Signal_SIGNAL_SIGKILL,
	}))
	io.Copy(io.Discard, &streamReader{stream})
}

func TestSelectorByTag(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	tag := "by-tag"
	stream, err := client.Start(context.Background(), connect.NewRequest(&procpb.StartRequest{
		Process: &procpb.ProcessConfig{Cmd: "/bin/cat"},
		Tag:     &tag,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() {
		t.Fatalf("no start: %v", stream.Err())
	}

	_, err = client.SendInput(context.Background(), connect.NewRequest(&procpb.SendInputRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Tag{Tag: tag}},
		Input:   &procpb.ProcessInput{Input: &procpb.ProcessInput_Stdin{Stdin: []byte("via tag\n")}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.CloseStdin(context.Background(), connect.NewRequest(&procpb.CloseStdinRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Tag{Tag: tag}},
	}))
	if err != nil {
		t.Fatal(err)
	}

	var out strings.Builder
	for stream.Receive() {
		ev := stream.Msg().Event
		if d, ok := ev.Event.(*procpb.ProcessEvent_Data); ok {
			if s, ok := d.Data.Output.(*procpb.ProcessEvent_DataEvent_Stdout); ok {
				out.Write(s.Stdout)
			}
		}
	}
	if !strings.Contains(out.String(), "via tag") {
		t.Errorf("tag selector failed: %q", out.String())
	}
}

func TestSelector_NotFound(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	_, err := client.SendInput(context.Background(), connect.NewRequest(&procpb.SendInputRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: 12345}},
		Input:   &procpb.ProcessInput{Input: &procpb.ProcessInput_Stdin{Stdin: []byte("x")}},
	}))
	if err == nil {
		t.Fatal("expected NotFound")
	}

	_, err = client.SendSignal(context.Background(), connect.NewRequest(&procpb.SendSignalRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: 12345}},
		Signal:  procpb.Signal_SIGNAL_SIGTERM,
	}))
	if err == nil {
		t.Fatal("expected NotFound on signal")
	}

	_, err = client.CloseStdin(context.Background(), connect.NewRequest(&procpb.CloseStdinRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: 12345}},
	}))
	if err == nil {
		t.Fatal("expected NotFound on close stdin")
	}
}

func TestStreamInput(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	stream, err := client.Start(context.Background(), connect.NewRequest(&procpb.StartRequest{
		Process: &procpb.ProcessConfig{Cmd: "/bin/cat"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() {
		t.Fatalf("no start: %v", stream.Err())
	}
	pid := stream.Msg().Event.Event.(*procpb.ProcessEvent_Start).Start.Pid

	si := client.StreamInput(context.Background())
	if err := si.Send(&procpb.StreamInputRequest{
		Event: &procpb.StreamInputRequest_Start{Start: &procpb.StreamInputRequest_StartEvent{
			Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: pid}},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := si.Send(&procpb.StreamInputRequest{
		Event: &procpb.StreamInputRequest_Data{Data: &procpb.StreamInputRequest_DataEvent{
			Input: &procpb.ProcessInput{Input: &procpb.ProcessInput_Stdin{Stdin: []byte("streamed\n")}},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := si.Send(&procpb.StreamInputRequest{
		Event: &procpb.StreamInputRequest_Keepalive{Keepalive: &procpb.StreamInputRequest_KeepAlive{}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := si.CloseAndReceive(); err != nil {
		t.Fatal(err)
	}

	_, err = client.CloseStdin(context.Background(), connect.NewRequest(&procpb.CloseStdinRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: pid}},
	}))
	if err != nil {
		t.Fatal(err)
	}

	var out strings.Builder
	for stream.Receive() {
		if d, ok := stream.Msg().Event.Event.(*procpb.ProcessEvent_Data); ok {
			if s, ok := d.Data.Output.(*procpb.ProcessEvent_DataEvent_Stdout); ok {
				out.Write(s.Stdout)
			}
		}
	}
	if !strings.Contains(out.String(), "streamed") {
		t.Errorf("streaminput didn't reach proc: %q", out.String())
	}
}

func TestStreamInput_DataBeforeStart(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	si := client.StreamInput(context.Background())
	if err := si.Send(&procpb.StreamInputRequest{
		Event: &procpb.StreamInputRequest_Data{Data: &procpb.StreamInputRequest_DataEvent{
			Input: &procpb.ProcessInput{Input: &procpb.ProcessInput_Stdin{Stdin: []byte("x")}},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	_, err := si.CloseAndReceive()
	if err == nil {
		t.Fatal("expected FailedPrecondition")
	}
}

func TestPTY_EchoAndExit(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("PTY tests require unix")
	}
	client, _, stop := newProcessTestServer(t)
	defer stop()

	stream, err := client.Start(context.Background(), connect.NewRequest(&procpb.StartRequest{
		Process: &procpb.ProcessConfig{Cmd: "/bin/sh"},
		Pty:     &procpb.PTY{Size: &procpb.PTY_Size{Cols: 80, Rows: 24}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() {
		t.Fatalf("no start: %v", stream.Err())
	}
	pid := stream.Msg().Event.Event.(*procpb.ProcessEvent_Start).Start.Pid

	_, err = client.SendInput(context.Background(), connect.NewRequest(&procpb.SendInputRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: pid}},
		Input:   &procpb.ProcessInput{Input: &procpb.ProcessInput_Pty{Pty: []byte("echo PTYWORKS\n")}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.SendInput(context.Background(), connect.NewRequest(&procpb.SendInputRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: pid}},
		Input:   &procpb.ProcessInput{Input: &procpb.ProcessInput_Pty{Pty: []byte("exit\n")}},
	}))
	if err != nil {
		t.Fatal(err)
	}

	var out strings.Builder
	for stream.Receive() {
		if d, ok := stream.Msg().Event.Event.(*procpb.ProcessEvent_Data); ok {
			if p, ok := d.Data.Output.(*procpb.ProcessEvent_DataEvent_Pty); ok {
				out.Write(p.Pty)
			}
		}
	}
	if !strings.Contains(out.String(), "PTYWORKS") {
		t.Errorf("PTY didn't echo: %q", out.String())
	}
}

func TestPTY_Resize(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("PTY tests require unix")
	}
	client, _, stop := newProcessTestServer(t)
	defer stop()

	stream, err := client.Start(context.Background(), connect.NewRequest(&procpb.StartRequest{
		Process: &procpb.ProcessConfig{Cmd: "/bin/sh"},
		Pty:     &procpb.PTY{Size: &procpb.PTY_Size{Cols: 80, Rows: 24}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() {
		t.Fatalf("no start: %v", stream.Err())
	}
	pid := stream.Msg().Event.Event.(*procpb.ProcessEvent_Start).Start.Pid

	_, err = client.Update(context.Background(), connect.NewRequest(&procpb.UpdateRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: pid}},
		Pty:     &procpb.PTY{Size: &procpb.PTY_Size{Cols: 120, Rows: 30}},
	}))
	if err != nil {
		t.Fatalf("resize: %v", err)
	}

	_, err = client.SendInput(context.Background(), connect.NewRequest(&procpb.SendInputRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: pid}},
		Input:   &procpb.ProcessInput{Input: &procpb.ProcessInput_Pty{Pty: []byte("exit\n")}},
	}))
	if err != nil {
		t.Fatal(err)
	}

	for stream.Receive() {
	}
}

func TestUpdate_NotFound(t *testing.T) {
	client, _, stop := newProcessTestServer(t)
	defer stop()

	_, err := client.Update(context.Background(), connect.NewRequest(&procpb.UpdateRequest{
		Process: &procpb.ProcessSelector{Selector: &procpb.ProcessSelector_Pid{Pid: 99}},
	}))
	if err == nil {
		t.Fatal("expected NotFound")
	}
}

func TestReplayBuffer_DropOldest(t *testing.T) {
	proc := &runningProc{
		subs: make(map[*subscriber]struct{}),
		done: make(chan struct{}),
	}
	// Push events totalling > replayLimitBytes.
	chunk := make([]byte, 64*1024)
	for i := 0; i < 20; i++ {
		proc.publish(&procpb.ProcessEvent{
			Event: &procpb.ProcessEvent_Data{
				Data: &procpb.ProcessEvent_DataEvent{
					Output: &procpb.ProcessEvent_DataEvent_Stdout{Stdout: chunk},
				},
			},
		})
	}
	if proc.replayBytes > replayLimitBytes {
		t.Errorf("replayBytes=%d exceeds cap %d", proc.replayBytes, replayLimitBytes)
	}
	if proc.replayBytes == 0 {
		t.Errorf("replayBytes=0, expected some retained")
	}
}

// streamReader adapts ServerStreamForClient to io.Reader for cleanup drains.
type streamReader struct {
	s *connect.ServerStreamForClient[procpb.StartResponse]
}

func (r *streamReader) Read(p []byte) (int, error) {
	if !r.s.Receive() {
		err := r.s.Err()
		if err == nil {
			err = io.EOF
		}
		return 0, err
	}
	return 0, nil
}
