package service

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
)

// Metrics is upstream envd's /metrics body, limited to what a macOS guest reports.
type Metrics struct {
	Timestamp  int64   `json:"ts"`
	CPUCount   int     `json:"cpu_count"`
	CPUUsedPct float64 `json:"cpu_used_pct"`
	MemTotal   uint64  `json:"mem_total"`
	MemUsed    uint64  `json:"mem_used"`
	MemCache   uint64  `json:"mem_cache"`
	DiskUsed   uint64  `json:"disk_used"`
	DiskTotal  uint64  `json:"disk_total"`
}

// CollectMetrics samples CPU use over the given interval.
func CollectMetrics(interval time.Duration) (Metrics, error) {
	m := Metrics{Timestamp: time.Now().Unix()}
	count, err := cpu.Counts(true)
	if err != nil {
		return m, err
	}
	m.CPUCount = count
	pct, err := cpu.Percent(interval, false)
	if err != nil {
		return m, err
	}
	if len(pct) > 0 {
		m.CPUUsedPct = pct[0]
	}
	vm, err := mem.VirtualMemory()
	if err != nil {
		return m, err
	}
	m.MemTotal, m.MemUsed, m.MemCache = vm.Total, vm.Used, vm.Cached
	usage, err := disk.Usage("/")
	if err != nil {
		return m, err
	}
	m.DiskTotal, m.DiskUsed = usage.Total, usage.Used
	return m, nil
}

// HandleMetrics serves GET /metrics.
func HandleMetrics(w http.ResponseWriter, r *http.Request) {
	m, err := CollectMetrics(200 * time.Millisecond)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(m)
}
