package service

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHandleMetrics_ReportsThisMachine(t *testing.T) {
	w := httptest.NewRecorder()
	HandleMetrics(w, httptest.NewRequest("GET", "/metrics", nil))
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var m map[string]float64
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"ts", "cpu_count", "mem_total", "mem_used", "disk_total", "disk_used"} {
		if m[key] <= 0 {
			t.Errorf("%s = %v, want > 0", key, m[key])
		}
	}
	if m["mem_used"] > m["mem_total"] || m["disk_used"] > m["disk_total"] {
		t.Errorf("used exceeds total: %v", m)
	}
	if pct := m["cpu_used_pct"]; pct < 0 || pct > 100 {
		t.Errorf("cpu_used_pct = %v", pct)
	}
	if now := float64(time.Now().Unix()); m["ts"] < now-60 || m["ts"] > now+60 {
		t.Errorf("ts = %v, now %v", m["ts"], now)
	}
}
