package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"connectrpc.com/connect"
	"github.com/creack/pty"

	procpb "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-runtime/gen/process"
	procrpc "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-runtime/gen/process/processconnect"
)

// replayLimitBytes caps the per-process replay buffer used for Connect
// re-attach. Output beyond this is dropped (oldest first) to prevent a
// runaway process from exhausting memory.
const replayLimitBytes = 1 << 20 // 1 MiB

// readChunkSize is the maximum payload size of a single DataEvent emitted by
// the output reader goroutines. Smaller chunks improve interactive latency.
const readChunkSize = 4096

var pidCounter atomic.Uint32

type subscriber struct {
	ch   chan *procpb.ProcessEvent
	gone chan struct{} // closed by unsubscribe
}

type runningProc struct {
	pid     uint32
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	ptyFile *os.File
	tag     string
	config  *procpb.ProcessConfig

	mu          sync.Mutex
	subs        map[*subscriber]struct{}
	replay      []*procpb.ProcessEvent
	replayBytes int

	endOnce  sync.Once
	endEvent *procpb.ProcessEvent
	done     chan struct{}

	// stdoutR/stderrR are the parent's read ends of the output pipes. They
	// are plain os.Pipe files owned here, not cmd.StdoutPipe, so cmd.Wait
	// neither closes them nor waits on them; reap does, after the process
	// has exited and the readers had a chance to drain.
	stdoutR, stderrR *os.File

	// readers tracks the stdout/stderr (or PTY) pumps. reap waits for them
	// before publishing End so that End follows every data event.
	readers sync.WaitGroup
}

// publish delivers an event to every current subscriber and appends it to the
// replay buffer, trimmed to replayLimitBytes. Delivery never drops events: a
// slow subscriber holds the output pump back, which fills the pipe and pauses
// the process, as a terminal would. Unsubscribing releases a blocked send.
func (p *runningProc) publish(ev *procpb.ProcessEvent) {
	p.mu.Lock()
	subs := make([]*subscriber, 0, len(p.subs))
	for s := range p.subs {
		subs = append(subs, s)
	}

	size := eventSize(ev)
	p.replay = append(p.replay, ev)
	p.replayBytes += size

	for p.replayBytes > replayLimitBytes && len(p.replay) > 0 {
		drop := p.replay[0]
		p.replayBytes -= eventSize(drop)
		p.replay = p.replay[1:]
	}
	p.mu.Unlock()

	for _, s := range subs {
		select {
		case s.ch <- ev:
		case <-s.gone:
		}
	}
}

func newSubscriber() *subscriber {
	return &subscriber{ch: make(chan *procpb.ProcessEvent, 64), gone: make(chan struct{})}
}

func (p *runningProc) subscribe() *subscriber {
	s := newSubscriber()
	p.mu.Lock()
	p.subs[s] = struct{}{}
	p.mu.Unlock()
	return s
}

// subscribeWithReplay attaches a subscriber and snapshots the replay buffer in
// one step, so every event is either replayed or delivered, never both.
func (p *runningProc) subscribeWithReplay() (*subscriber, []*procpb.ProcessEvent) {
	s := newSubscriber()
	p.mu.Lock()
	defer p.mu.Unlock()
	p.subs[s] = struct{}{}
	replay := make([]*procpb.ProcessEvent, len(p.replay))
	copy(replay, p.replay)
	return s, replay
}

func (p *runningProc) unsubscribe(s *subscriber) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.subs[s]; ok {
		delete(p.subs, s)
		close(s.gone)
	}
}

func eventSize(ev *procpb.ProcessEvent) int {
	if d, ok := ev.Event.(*procpb.ProcessEvent_Data); ok {
		switch out := d.Data.Output.(type) {
		case *procpb.ProcessEvent_DataEvent_Stdout:
			return len(out.Stdout)
		case *procpb.ProcessEvent_DataEvent_Stderr:
			return len(out.Stderr)
		case *procpb.ProcessEvent_DataEvent_Pty:
			return len(out.Pty)
		}
	}
	return 0
}

type ProcessService struct {
	procrpc.UnimplementedProcessHandler
	mu    sync.Mutex
	procs map[uint32]*runningProc
	// GetEnv returns the current environment variables (global + per-request).
	GetEnv func() []string
}

func NewProcessService(getEnv func() []string) *ProcessService {
	return &ProcessService{
		procs:  make(map[uint32]*runningProc),
		GetEnv: getEnv,
	}
}

func (s *ProcessService) Start(ctx context.Context, req *connect.Request[procpb.StartRequest], stream *connect.ServerStream[procpb.StartResponse]) error {
	cfg := req.Msg.Process
	if cfg == nil {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("process config required"))
	}

	proc, sub, err := s.spawn(cfg, req.Msg.Pty, req.Msg.Tag)
	if err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}
	defer proc.unsubscribe(sub)

	startEv := &procpb.ProcessEvent{
		Event: &procpb.ProcessEvent_Start{
			Start: &procpb.ProcessEvent_StartEvent{Pid: proc.pid},
		},
	}
	if err := stream.Send(&procpb.StartResponse{Event: startEv}); err != nil {
		return err
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case ev, ok := <-sub.ch:
			if !ok {
				return nil
			}
			if err := stream.Send(&procpb.StartResponse{Event: ev}); err != nil {
				return err
			}
			if _, isEnd := ev.Event.(*procpb.ProcessEvent_End); isEnd {
				return nil
			}
		case <-proc.done:
			// Drain any remaining buffered events.
			for {
				select {
				case ev := <-sub.ch:
					stream.Send(&procpb.StartResponse{Event: ev})
				default:
					return nil
				}
			}
		}
	}
}

// spawn launches a process (PTY or pipe-based) and registers it in the
// service's process table. The output reader goroutines publish data events
// to subscribers and append to the replay buffer. The returned subscriber is
// attached before the process starts, so it sees every event, even from a
// process that exits at once.
func (s *ProcessService) spawn(cfg *procpb.ProcessConfig, ptyCfg *procpb.PTY, tagPtr *string) (*runningProc, *subscriber, error) {
	cmd := exec.Command(cfg.Cmd, cfg.Args...)

	if cfg.Cwd != nil {
		cmd.Dir = *cfg.Cwd
	}

	env := s.GetEnv()
	for k, v := range cfg.Envs {
		env = append(env, k+"="+v)
	}
	cmd.Env = env

	pid := pidCounter.Add(1)
	tag := ""
	if tagPtr != nil {
		tag = *tagPtr
	}

	proc := &runningProc{
		pid:    pid,
		cmd:    cmd,
		tag:    tag,
		config: cfg,
		subs:   make(map[*subscriber]struct{}),
		done:   make(chan struct{}),
	}
	sub := proc.subscribe()

	if ptyCfg != nil {
		size := &pty.Winsize{Cols: 80, Rows: 24}
		if ptyCfg.Size != nil {
			if ptyCfg.Size.Cols > 0 {
				size.Cols = uint16(ptyCfg.Size.Cols)
			}
			if ptyCfg.Size.Rows > 0 {
				size.Rows = uint16(ptyCfg.Size.Rows)
			}
		}
		// pty.StartWithSize sets Setsid:true and gives the child a controlling tty.
		ptmx, err := pty.StartWithSize(cmd, size)
		if err != nil {
			return nil, nil, err
		}
		proc.ptyFile = ptmx
		proc.stdin = ptmx
		proc.readers.Add(1)
		go s.readPTY(proc, ptmx)
	} else {
		// Place the child in its own process group so signals/cleanup can target
		// the whole group, not just the leader.
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

		stdin, err := cmd.StdinPipe()
		if err != nil {
			return nil, nil, err
		}
		// Own the output pipes instead of using cmd.StdoutPipe: exec passes an
		// *os.File straight to the child, so cmd.Wait returns when the process
		// exits rather than when the last writer (possibly a background child
		// that inherited the pipe) closes it.
		stdoutR, stdoutW, err := os.Pipe()
		if err != nil {
			return nil, nil, err
		}
		stderrR, stderrW, err := os.Pipe()
		if err != nil {
			stdoutR.Close()
			stdoutW.Close()
			return nil, nil, err
		}
		cmd.Stdout = stdoutW
		cmd.Stderr = stderrW
		err = cmd.Start()
		// The child holds its own copies; the parent must drop the write ends
		// or the readers would never see EOF.
		stdoutW.Close()
		stderrW.Close()
		if err != nil {
			stdoutR.Close()
			stderrR.Close()
			return nil, nil, err
		}
		proc.stdin = stdin
		proc.stdoutR = stdoutR
		proc.stderrR = stderrR
		proc.readers.Add(2)
		go s.readStream(proc, stdoutR, true)
		go s.readStream(proc, stderrR, false)
	}

	s.mu.Lock()
	s.procs[pid] = proc
	s.mu.Unlock()

	go s.reap(proc)
	return proc, sub, nil
}

func (s *ProcessService) readStream(proc *runningProc, r io.Reader, isStdout bool) {
	defer proc.readers.Done()
	buf := make([]byte, readChunkSize)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			var data *procpb.ProcessEvent_DataEvent
			if isStdout {
				data = &procpb.ProcessEvent_DataEvent{
					Output: &procpb.ProcessEvent_DataEvent_Stdout{Stdout: chunk},
				}
			} else {
				data = &procpb.ProcessEvent_DataEvent{
					Output: &procpb.ProcessEvent_DataEvent_Stderr{Stderr: chunk},
				}
			}
			proc.publish(&procpb.ProcessEvent{
				Event: &procpb.ProcessEvent_Data{Data: data},
			})
		}
		if err != nil {
			return
		}
	}
}

func (s *ProcessService) readPTY(proc *runningProc, ptmx *os.File) {
	defer proc.readers.Done()
	buf := make([]byte, readChunkSize)
	for {
		n, err := ptmx.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			proc.publish(&procpb.ProcessEvent{
				Event: &procpb.ProcessEvent_Data{
					Data: &procpb.ProcessEvent_DataEvent{
						Output: &procpb.ProcessEvent_DataEvent_Pty{Pty: chunk},
					},
				},
			})
		}
		if err != nil {
			return
		}
	}
}

func (s *ProcessService) reap(proc *runningProc) {
	// Returns when the process itself exits. Nothing here waits on the output
	// pipes, so a background child that inherited them cannot hold End back.
	err := proc.cmd.Wait()

	// Output written just before exit may still be in the pipe. Normally the
	// readers hit EOF within microseconds; if a lingering child keeps the
	// write end open, give up after a short drain window instead.
	readersDone := make(chan struct{})
	go func() {
		proc.readers.Wait()
		close(readersDone)
	}()
	select {
	case <-readersDone:
	case <-time.After(200 * time.Millisecond):
	}

	// Close the parent's read ends so blocked readers return, then wait for
	// them so End is published after every data event.
	for _, f := range []*os.File{proc.stdoutR, proc.stderrR, proc.ptyFile} {
		if f != nil {
			f.Close()
		}
	}
	<-readersDone

	exitCode := int32(0)
	exited := true
	status := "exited"
	var errMsg *string
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = int32(exitErr.ExitCode())
			if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				sig := ws.Signal()
				status = fmt.Sprintf("signal: %s", sig)
				exitCode = int32(128 + int(sig))
			} else {
				status = fmt.Sprintf("exit status %d", exitCode)
			}
		} else {
			s := err.Error()
			errMsg = &s
			exited = false
			status = "error"
		}
	}

	end := &procpb.ProcessEvent{
		Event: &procpb.ProcessEvent_End{
			End: &procpb.ProcessEvent_EndEvent{
				ExitCode: exitCode,
				Exited:   exited,
				Status:   status,
				Error:    errMsg,
			},
		},
	}

	proc.endOnce.Do(func() {
		proc.endEvent = end
		proc.publish(end)
		close(proc.done)
	})

	// Linger briefly so late Connect calls can still observe the end event.
	go func() {
		time.Sleep(5 * time.Second)
		s.mu.Lock()
		if s.procs[proc.pid] == proc {
			delete(s.procs, proc.pid)
		}
		s.mu.Unlock()
	}()
}

func (s *ProcessService) List(ctx context.Context, req *connect.Request[procpb.ListRequest]) (*connect.Response[procpb.ListResponse], error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var infos []*procpb.ProcessInfo
	for pid, p := range s.procs {
		select {
		case <-p.done:
			continue
		default:
		}
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

func (s *ProcessService) SendInput(ctx context.Context, req *connect.Request[procpb.SendInputRequest]) (*connect.Response[procpb.SendInputResponse], error) {
	proc := s.getProc(req.Msg.Process)
	if proc == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("process not found"))
	}
	if err := writeInput(proc, req.Msg.Input); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&procpb.SendInputResponse{}), nil
}

func writeInput(proc *runningProc, in *procpb.ProcessInput) error {
	if in == nil {
		return nil
	}
	switch v := in.Input.(type) {
	case *procpb.ProcessInput_Stdin:
		if proc.ptyFile != nil {
			_, err := proc.ptyFile.Write(v.Stdin)
			return err
		}
		if proc.stdin != nil {
			_, err := proc.stdin.Write(v.Stdin)
			return err
		}
	case *procpb.ProcessInput_Pty:
		if proc.ptyFile != nil {
			_, err := proc.ptyFile.Write(v.Pty)
			return err
		}
	}
	return nil
}

func (s *ProcessService) SendSignal(ctx context.Context, req *connect.Request[procpb.SendSignalRequest]) (*connect.Response[procpb.SendSignalResponse], error) {
	proc := s.getProc(req.Msg.Process)
	if proc == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("process not found"))
	}
	if proc.cmd.Process != nil {
		sig := syscall.SIGTERM
		if req.Msg.Signal == procpb.Signal_SIGNAL_SIGKILL {
			sig = syscall.SIGKILL
		}
		// Signal the whole process group when we set Setpgid above.
		pgid := proc.cmd.Process.Pid
		if proc.cmd.SysProcAttr != nil && proc.cmd.SysProcAttr.Setpgid {
			if g, err := syscall.Getpgid(proc.cmd.Process.Pid); err == nil {
				pgid = g
			}
			syscall.Kill(-pgid, sig)
		} else {
			proc.cmd.Process.Signal(sig)
		}
	}
	return connect.NewResponse(&procpb.SendSignalResponse{}), nil
}

func (s *ProcessService) CloseStdin(ctx context.Context, req *connect.Request[procpb.CloseStdinRequest]) (*connect.Response[procpb.CloseStdinResponse], error) {
	proc := s.getProc(req.Msg.Process)
	if proc == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("process not found"))
	}
	if proc.ptyFile != nil {
		// stdin on PTYs is not closable independently; send Ctrl+D instead.
		proc.ptyFile.Write([]byte{0x04})
	} else if proc.stdin != nil {
		proc.stdin.Close()
	}
	return connect.NewResponse(&procpb.CloseStdinResponse{}), nil
}

func (s *ProcessService) Connect(ctx context.Context, req *connect.Request[procpb.ConnectRequest], stream *connect.ServerStream[procpb.ConnectResponse]) error {
	proc := s.getProc(req.Msg.Process)
	if proc == nil {
		return connect.NewError(connect.CodeNotFound, fmt.Errorf("process not found"))
	}

	if err := stream.Send(&procpb.ConnectResponse{
		Event: &procpb.ProcessEvent{
			Event: &procpb.ProcessEvent_Start{
				Start: &procpb.ProcessEvent_StartEvent{Pid: proc.pid},
			},
		},
	}); err != nil {
		return err
	}

	sub, replay := proc.subscribeWithReplay()
	defer proc.unsubscribe(sub)

	for _, ev := range replay {
		if err := stream.Send(&procpb.ConnectResponse{Event: ev}); err != nil {
			return err
		}
		if _, isEnd := ev.Event.(*procpb.ProcessEvent_End); isEnd {
			return nil
		}
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case ev := <-sub.ch:
			if err := stream.Send(&procpb.ConnectResponse{Event: ev}); err != nil {
				return err
			}
			if _, isEnd := ev.Event.(*procpb.ProcessEvent_End); isEnd {
				return nil
			}
		case <-proc.done:
			for {
				select {
				case ev := <-sub.ch:
					stream.Send(&procpb.ConnectResponse{Event: ev})
				default:
					return nil
				}
			}
		}
	}
}

func (s *ProcessService) Update(ctx context.Context, req *connect.Request[procpb.UpdateRequest]) (*connect.Response[procpb.UpdateResponse], error) {
	proc := s.getProc(req.Msg.Process)
	if proc == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("process not found"))
	}
	if req.Msg.Pty != nil && proc.ptyFile != nil {
		size := &pty.Winsize{Cols: 80, Rows: 24}
		if req.Msg.Pty.Size != nil {
			if req.Msg.Pty.Size.Cols > 0 {
				size.Cols = uint16(req.Msg.Pty.Size.Cols)
			}
			if req.Msg.Pty.Size.Rows > 0 {
				size.Rows = uint16(req.Msg.Pty.Size.Rows)
			}
		}
		if err := pty.Setsize(proc.ptyFile, size); err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
	}
	return connect.NewResponse(&procpb.UpdateResponse{}), nil
}

func (s *ProcessService) StreamInput(ctx context.Context, stream *connect.ClientStream[procpb.StreamInputRequest]) (*connect.Response[procpb.StreamInputResponse], error) {
	var target *runningProc
	for stream.Receive() {
		msg := stream.Msg()
		switch ev := msg.Event.(type) {
		case *procpb.StreamInputRequest_Start:
			target = s.getProc(ev.Start.Process)
			if target == nil {
				return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("process not found"))
			}
		case *procpb.StreamInputRequest_Data:
			if target == nil {
				return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("start event required first"))
			}
			if err := writeInput(target, ev.Data.Input); err != nil {
				return nil, connect.NewError(connect.CodeInternal, err)
			}
		case *procpb.StreamInputRequest_Keepalive:
			// noop
		}
	}
	if err := stream.Err(); err != nil {
		return nil, err
	}
	return connect.NewResponse(&procpb.StreamInputResponse{}), nil
}

func (s *ProcessService) getProc(sel *procpb.ProcessSelector) *runningProc {
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
