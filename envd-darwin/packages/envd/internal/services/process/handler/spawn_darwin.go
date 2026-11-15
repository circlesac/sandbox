//go:build darwin

package handler

import (
	"context"
	"os"
	"os/exec"
	"os/user"
	"syscall"

	"github.com/e2b-dev/infra/packages/envd/internal/permissions"
	"github.com/e2b-dev/infra/packages/envd/internal/services/cgroups"
	rpc "github.com/e2b-dev/infra/packages/envd/internal/services/spec/process"
	"github.com/rs/zerolog"
)

func newCommand(ctx context.Context, u *user.User, req *rpc.StartRequest, _ *zerolog.Logger, _ cgroups.Manager) (*exec.Cmd, *sysState, error) {
	uid, gid, err := permissions.GetUserIdUints(u)
	if err != nil {
		return nil, nil, err
	}
	cmd := exec.CommandContext(ctx, req.GetProcess().GetCmd(), req.GetProcess().GetArgs()...)
	// A LaunchAgent already runs as the login user. Calling setgroups even for
	// that same user fails on macOS and is unnecessary for inherited credentials.
	if int(uid) != os.Geteuid() || int(gid) != os.Getegid() {
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid, NoSetGroups: true}}
	}
	return cmd, &sysState{}, nil
}

func signalPid(pid int, signal syscall.Signal) error {
	return syscall.Kill(pid, signal)
}
