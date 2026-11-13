//go:build unix && !darwin

package process

const defaultHandoverPath = "/run/e2b/envd-handover.pb"
