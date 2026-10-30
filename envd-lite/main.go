// envd-lite: Minimal envd for macOS VMs (Tart backend).
// Implements the E2B envd API surface needed by the SDK.
//
//go:generate bash upstream/e2b-dev-runtime/generate.sh
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"

	"github.com/rs/cors"

	"github.com/circlesac/sandbox/envd-lite/service"
	fsrpc "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-runtime/gen/filesystem/filesystemconnect"
	procrpc "github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-runtime/gen/process/processconnect"
)

func main() {
	port := flag.Int("port", 49983, "listen port")
	flag.Bool("isnotfc", false, "ignored, compatibility flag")
	showVersion := flag.Bool("version", false, "print the envd API version this implements")
	flag.Parse()

	if *showVersion {
		fmt.Println(service.Version)
		return
	}

	state := service.NewEnvState()
	token := &service.AccessToken{}

	mux := http.NewServeMux()

	// REST endpoints
	mux.HandleFunc("/health", service.HandleHealth)
	mux.HandleFunc("/init", service.HandleInit(state, token))
	mux.HandleFunc("/metrics", service.HandleMetrics)
	mux.HandleFunc("/envs", service.HandleEnvs(state))
	mux.HandleFunc("/files", service.HandleFiles)

	// connectrpc services
	procPath, procHandler := procrpc.NewProcessHandler(
		service.NewProcessService(state.Environ),
	)
	mux.Handle(procPath, procHandler)

	fsPath, fsHandler := fsrpc.NewFilesystemHandler(service.NewFilesystemService())
	mux.Handle(fsPath, fsHandler)

	handler := cors.New(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{"*"},
		ExposedHeaders: []string{"*"},
	}).Handler(token.Middleware(mux))

	addr := fmt.Sprintf("0.0.0.0:%d", *port)
	log.Printf("envd-lite listening on %s", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatal(err)
	}
}
