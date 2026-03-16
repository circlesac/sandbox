package service

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	fspb "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen/filesystem"
	fsrpc "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen/filesystem/filesystemconnect"
)

type FilesystemService struct {
	fsrpc.UnimplementedFilesystemHandler
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
	return connect.NewError(connect.CodeUnimplemented, fmt.Errorf("watchdir not implemented"))
}

func (s *FilesystemService) CreateWatcher(ctx context.Context, req *connect.Request[fspb.CreateWatcherRequest]) (*connect.Response[fspb.CreateWatcherResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("not implemented"))
}

func (s *FilesystemService) GetWatcherEvents(ctx context.Context, req *connect.Request[fspb.GetWatcherEventsRequest]) (*connect.Response[fspb.GetWatcherEventsResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("not implemented"))
}

func (s *FilesystemService) RemoveWatcher(ctx context.Context, req *connect.Request[fspb.RemoveWatcherRequest]) (*connect.Response[fspb.RemoveWatcherResponse], error) {
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
