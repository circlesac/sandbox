package service

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"

	"connectrpc.com/connect"

	procpb "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen/process"
	procrpc "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen/process/processconnect"
)

var pidCounter atomic.Uint32

type runningProc struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	tag    string
	config *procpb.ProcessConfig
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

	cmd := exec.CommandContext(ctx, cfg.Cmd, cfg.Args...)

	if cfg.Cwd != nil {
		cmd.Dir = *cfg.Cwd
	}

	env := s.GetEnv()
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

	var sendMu sync.Mutex

	sendMu.Lock()
	stream.Send(&procpb.StartResponse{
		Event: &procpb.ProcessEvent{
			Event: &procpb.ProcessEvent_Start{
				Start: &procpb.ProcessEvent_StartEvent{Pid: pid},
			},
		},
	})
	sendMu.Unlock()

	var stdoutBuf, stderrBuf []byte
	done := make(chan struct{}, 2)

	go func() {
		stdoutBuf, _ = io.ReadAll(stdoutR)
		done <- struct{}{}
	}()

	go func() {
		stderrBuf, _ = io.ReadAll(stderrR)
		done <- struct{}{}
	}()

	<-done
	<-done
	err := cmd.Wait()

	if len(stdoutBuf) > 0 {
		sendMu.Lock()
		stream.Send(&procpb.StartResponse{
			Event: &procpb.ProcessEvent{
				Event: &procpb.ProcessEvent_Data{
					Data: &procpb.ProcessEvent_DataEvent{
						Output: &procpb.ProcessEvent_DataEvent_Stdout{Stdout: stdoutBuf},
					},
				},
			},
		})
		sendMu.Unlock()
	}

	if len(stderrBuf) > 0 {
		sendMu.Lock()
		stream.Send(&procpb.StartResponse{
			Event: &procpb.ProcessEvent{
				Event: &procpb.ProcessEvent_Data{
					Data: &procpb.ProcessEvent_DataEvent{
						Output: &procpb.ProcessEvent_DataEvent_Stderr{Stderr: stderrBuf},
					},
				},
			},
		})
		sendMu.Unlock()
	}

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

	sendMu.Lock()
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
	sendMu.Unlock()

	s.mu.Lock()
	delete(s.procs, pid)
	s.mu.Unlock()

	return nil
}

func (s *ProcessService) List(ctx context.Context, req *connect.Request[procpb.ListRequest]) (*connect.Response[procpb.ListResponse], error) {
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

func (s *ProcessService) SendInput(ctx context.Context, req *connect.Request[procpb.SendInputRequest]) (*connect.Response[procpb.SendInputResponse], error) {
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
		proc.cmd.Process.Signal(sig)
	}
	return connect.NewResponse(&procpb.SendSignalResponse{}), nil
}

func (s *ProcessService) CloseStdin(ctx context.Context, req *connect.Request[procpb.CloseStdinRequest]) (*connect.Response[procpb.CloseStdinResponse], error) {
	proc := s.getProc(req.Msg.Process)
	if proc == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("process not found"))
	}
	proc.stdin.Close()
	return connect.NewResponse(&procpb.CloseStdinResponse{}), nil
}

func (s *ProcessService) Connect(ctx context.Context, req *connect.Request[procpb.ConnectRequest], stream *connect.ServerStream[procpb.ConnectResponse]) error {
	return connect.NewError(connect.CodeUnimplemented, fmt.Errorf("connect not implemented"))
}

func (s *ProcessService) Update(ctx context.Context, req *connect.Request[procpb.UpdateRequest]) (*connect.Response[procpb.UpdateResponse], error) {
	return connect.NewResponse(&procpb.UpdateResponse{}), nil
}

func (s *ProcessService) StreamInput(ctx context.Context, stream *connect.ClientStream[procpb.StreamInputRequest]) (*connect.Response[procpb.StreamInputResponse], error) {
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
