package service

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func sign(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return "v1_" + strings.TrimRight(base64.StdEncoding.EncodeToString(sum[:]), "=")
}

func guarded(token string) http.Handler {
	a := &AccessToken{}
	a.Set(token)
	return a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

func status(h http.Handler, method, target string, header map[string]string) int {
	r := httptest.NewRequest(method, target, nil)
	for k, v := range header {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code
}

func TestAccessToken_OpenUntilInitSetsOne(t *testing.T) {
	if got := status(guarded(""), "POST", "/process.Process/Start", nil); got != 200 {
		t.Errorf("no token set: got %d", got)
	}
}

func TestAccessToken_RequiresTheHeader(t *testing.T) {
	h := guarded("tok123")
	if got := status(h, "POST", "/process.Process/Start", nil); got != 401 {
		t.Errorf("missing: got %d", got)
	}
	if got := status(h, "POST", "/process.Process/Start", map[string]string{"X-Access-Token": "nope"}); got != 401 {
		t.Errorf("wrong: got %d", got)
	}
	if got := status(h, "POST", "/process.Process/Start", map[string]string{"X-Access-Token": "tok123"}); got != 200 {
		t.Errorf("right: got %d", got)
	}
	if got := status(h, "GET", "/health", nil); got != 200 {
		t.Errorf("/health must stay open: got %d", got)
	}
	if got := status(h, "GET", "/metrics", nil); got != 401 {
		t.Errorf("/metrics: got %d", got)
	}
}

func TestAccessToken_AcceptsSignedFileURLs(t *testing.T) {
	h := guarded("tok123")
	// The same vector as the control plane's tests, from Python's hashlib.
	sig := url.QueryEscape("v1_HB2bgZ+RgifWQVkD4WDT8wNBFTVrggZWSRD5EqI0H/0")
	if sign("/home/user/a.txt:read:user:tok123") != "v1_HB2bgZ+RgifWQVkD4WDT8wNBFTVrggZWSRD5EqI0H/0" {
		t.Fatal("signature vector mismatch")
	}
	ok := "/files?path=/home/user/a.txt&username=user&signature=" + sig
	if got := status(h, "GET", ok, nil); got != 200 {
		t.Errorf("valid read signature: got %d", got)
	}
	if got := status(h, "POST", ok, nil); got != 401 {
		t.Errorf("read signature used for a write: got %d", got)
	}
	tampered := "/files?path=/etc/shadow&username=user&signature=" + sig
	if got := status(h, "GET", tampered, nil); got != 401 {
		t.Errorf("tampered path: got %d", got)
	}
	if got := status(h, "GET", "/envs?signature="+sig, nil); got != 401 {
		t.Errorf("signatures only cover /files: got %d", got)
	}
}

func TestAccessToken_SignatureExpiry(t *testing.T) {
	future := time.Now().Add(time.Hour).Unix()
	past := time.Now().Add(-time.Second).Unix()
	for _, tc := range []struct {
		exp  int64
		want bool
	}{{future, true}, {past, false}} {
		raw := "/tmp/up.bin:write::tok123:" + itoa(tc.exp)
		r := httptest.NewRequest("POST", "/files?path=/tmp/up.bin&signature="+url.QueryEscape(sign(raw))+"&signature_expiration="+itoa(tc.exp), nil)
		if got := validFileSignature(r, "tok123", time.Now()); got != tc.want {
			t.Errorf("expiration %d: got %v, want %v", tc.exp, got, tc.want)
		}
	}
}

func TestHandleInit_TokenRules(t *testing.T) {
	state := NewEnvState()
	token := &AccessToken{}
	init := HandleInit(state, token)
	post := func(body string, header string) int {
		r := httptest.NewRequest("POST", "/init", strings.NewReader(body))
		if header != "" {
			r.Header.Set("X-Access-Token", header)
		}
		w := httptest.NewRecorder()
		init(w, r)
		return w.Code
	}

	if got := post(`{"accessToken":"first"}`, ""); got != 204 {
		t.Fatalf("first init: got %d", got)
	}
	if token.Get() != "first" {
		t.Fatalf("token not set")
	}
	// Re-initializing with the same token (as on resume) works.
	if got := post(`{"accessToken":"first","envVars":{"A":"1"}}`, ""); got != 204 {
		t.Errorf("same token: got %d", got)
	}
	// Someone without the token cannot replace it.
	if got := post(`{"accessToken":"stolen"}`, ""); got != 401 || token.Get() != "first" {
		t.Errorf("replace without token: got %d, token %q", got, token.Get())
	}
	// Knowing the current token allows rotation.
	if got := post(`{"accessToken":"second"}`, "first"); got != 204 || token.Get() != "second" {
		t.Errorf("rotation: got %d, token %q", got, token.Get())
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
