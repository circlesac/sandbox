package service

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// AccessToken guards the API once /init sets a token, as upstream envd does:
// requests carry X-Access-Token, and /files URLs may carry an E2B signature
// instead (Sandbox.uploadUrl / downloadUrl).
type AccessToken struct {
	mu    sync.RWMutex
	token string
}

func (a *AccessToken) Get() string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.token
}

func (a *AccessToken) Set(token string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.token = token
}

// Middleware rejects requests without the token. /health stays open, and
// /init checks the token itself so the control plane can re-initialize.
func (a *AccessToken) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := a.Get()
		if token == "" || r.Method == http.MethodOptions ||
			r.URL.Path == "/health" || r.URL.Path == "/init" ||
			tokensEqual(r.Header.Get("X-Access-Token"), token) ||
			(r.URL.Path == "/files" && validFileSignature(r, token, time.Now())) {
			next.ServeHTTP(w, r)
			return
		}
		http.Error(w, `{"code":401,"message":"missing or invalid access token"}`, http.StatusUnauthorized)
	})
}

func tokensEqual(a, b string) bool {
	return a != "" && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// validFileSignature checks "v1_" + unpadded base64(sha256(path:operation:user:token[:expiration])).
func validFileSignature(r *http.Request, token string, now time.Time) bool {
	q := r.URL.Query()
	signature := q.Get("signature")
	if signature == "" {
		return false
	}
	operation := "write"
	if r.Method == http.MethodGet {
		operation = "read"
	}
	raw := q.Get("path") + ":" + operation + ":" + q.Get("username") + ":" + token
	if expiration := q.Get("signature_expiration"); expiration != "" {
		expiresAt, err := strconv.ParseInt(expiration, 10, 64)
		if err != nil || expiresAt < now.Unix() {
			return false
		}
		raw += ":" + expiration
	}
	sum := sha256.Sum256([]byte(raw))
	expected := "v1_" + strings.TrimRight(base64.StdEncoding.EncodeToString(sum[:]), "=")
	return tokensEqual(signature, expected)
}
