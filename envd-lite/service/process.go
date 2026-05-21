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

	procpb "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen/process"
	procrpc "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen/process/processconnect"
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
	ch chan *procpb.ProcessEvent
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
}

// publish fans out an event to all current subscribers (best-effort, drops on
// slow consumers) and appends to the replay buffer trimmed to replayLimitBytes.
func (p *runningProc) publish(ev *procpb.ProcessEvent) {
	p.mu.Lock()
	defer p.mu.Unlock()

	for s := range p.subs {
		select {
		case s.ch <- ev:
		default:
		}
	}

	size := eventSize(ev)
	p.replay = append(p.replay, ev)
	p.replayBytes += size

	for p.replayBytes > replayLimitBytes && len(p.replay) > 0 {
		drop := p.replay[0]
		p.replayBytes -= eventSize(drop)
		p.replay = p.replay[1:]
	}
}

func (p *runningProc) snapshotReplay() []*procpb.ProcessEvent {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]*procpb.ProcessEvent, len(p.replay))
	copy(out, p.replay)
	return out
}

func (p *runningProc) subscribe() *subscriber {
	s := &subscriber{ch: make(chan *procpb.ProcessEvent, 64)}
	p.mu.Lock()
	p.subs[s] = struct{}{}
	p.mu.Unlock()
	return s
}

func (p *runningProc) unsubscribe(s *subscriber) {
	p.mu.Lock()
	delete(p.subs, s)
	p.mu.Unlock()
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

	proc, err := s.spawn(cfg, req.Msg.Pty, req.Msg.Tag)
	if err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}

	startEv := &procpb.ProcessEvent{
		Event: &procpb.ProcessEvent_Start{
			Start: &procpb.ProcessEvent_StartEvent{Pid: proc.pid},
		},
	}
	if err := stream.Send(&procpb.StartResponse{Event: startEv}); err != nil {
		return err
	}

	sub := proc.subscribe()
	defer proc.unsubscribe(sub)

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
// to subscribers and append to the replay buffer.
func (s *ProcessService) spawn(cfg *procpb.ProcessConfig, ptyCfg *procpb.PTY, tagPtr *string) (*runningProc, error) {
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
			return nil, err
		}
		proc.ptyFile = ptmx
		proc.stdin = ptmx
		go s.readPTY(proc, ptmx)
	} else {
		// Place the child in its own process group so signals/cleanup can target
		// the whole group, not just the leader.
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

		stdin, err := cmd.StdinPipe()
		if err != nil {
			return nil, err
		}
		stdoutR, err := cmd.StdoutPipe()
		if err != nil {
			return nil, err
		}
		stderrR, err := cmd.StderrPipe()
		if err != nil {
			return nil, err
		}
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		proc.stdin = stdin
		go s.readStream(proc, stdoutR, true)
		go s.readStream(proc, stderrR, false)
	}

	s.mu.Lock()
	s.procs[pid] = proc
	s.mu.Unlock()

	go s.reap(proc)
	return proc, nil
}

func (s *ProcessService) readStream(proc *runningProc, r io.ReadCloser, isStdout bool) {
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
	err := proc.cmd.Wait()

	if proc.ptyFile != nil {
		proc.ptyFile.Close()
	}

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

	sub := proc.subscribe()
	defer proc.unsubscribe(sub)

	// Replay buffered events (snapshot taken after subscribing to avoid gaps).
	for _, ev := range proc.snapshotReplay() {
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
