// Package hermes resolves hermes://<service>/<scheme> secret references against
// the local Hermes broker at spawn time. Resolved values are returned to the
// caller for injection into a child process env ONLY — this package never writes
// a secret to disk, a log, or the published config.
//
// Broker contract (discovered in ~/Projects/hermes):
//   - broker HTTP:  http://127.0.0.1:9876  (config.json httpPort / HERMES_BROKER_URL)
//   - endpoint:     GET /token/:service/:scheme
//   - auth:         Authorization: Bearer <~/.hermes/client.token>
//   - response:     JSON TokenBundle, secret value is the "accessToken" field
//     (packages/broker/src/http-server.ts:184, packages/client/src/client.ts:476)
package hermes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// Ref scheme prefixes. A value beginning with either is a secret reference:
	//   hermes://<service>/<scheme>      -> broker /token (OAuth/session accessToken)
	//   hermescred://<service>/<account> -> broker /cred  (static credential value —
	//                                        the read side of `hermes creds set`,
	//                                        for API keys / PATs that have no OAuth flow)
	RefPrefix     = "hermes://"
	CredRefPrefix = "hermescred://"

	defaultBrokerURL = "http://127.0.0.1:9876"
	fetchTimeout     = 10 * time.Second
)

// IsRef reports whether an env value is a hermes secret reference (either scheme).
func IsRef(v string) bool {
	return strings.HasPrefix(v, RefPrefix) || strings.HasPrefix(v, CredRefPrefix)
}

// Resolver fetches secrets from the Hermes broker.
type Resolver struct {
	brokerURL   string
	clientToken string
	http        *http.Client
}

// NewResolver builds a resolver from the environment and ~/.hermes state.
// A missing client token is not fatal here — resolution simply fails per-ref at
// spawn time, letting the supervisor mark only the affected server degraded
// (literal-env servers are unaffected).
func NewResolver() *Resolver {
	broker := os.Getenv("HERMES_BROKER_URL")
	if broker == "" {
		broker = defaultBrokerURL
	}
	token := ""
	if home, err := os.UserHomeDir(); err == nil {
		if b, err := os.ReadFile(filepath.Join(home, ".hermes", "client.token")); err == nil {
			token = strings.TrimSpace(string(b))
		}
	}
	return &Resolver{
		brokerURL:   strings.TrimRight(broker, "/"),
		clientToken: token,
		http:        &http.Client{Timeout: fetchTimeout},
	}
}

// parseRef splits hermes://<service>/<scheme> or hermescred://<service>/<account>
// into its two parts (stripping whichever scheme prefix is present).
func parseRef(ref string) (service, name string, err error) {
	rest := ref
	if strings.HasPrefix(rest, CredRefPrefix) {
		rest = strings.TrimPrefix(rest, CredRefPrefix)
	} else {
		rest = strings.TrimPrefix(rest, RefPrefix)
	}
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("malformed hermes ref %q (want hermes://<service>/<scheme> or hermescred://<service>/<account>)", ref)
	}
	return parts[0], parts[1], nil
}

// Resolve fetches the secret for a hermes:// or hermescred:// reference and
// returns its plaintext value. hermes:// hits the broker /token endpoint (reads
// the bundle's accessToken); hermescred:// hits /cred (reads the stored value,
// the read side of `hermes creds set`). The value is intended for child-env
// injection ONLY; callers MUST NOT log or persist it.
func (r *Resolver) Resolve(ctx context.Context, ref string) (string, error) {
	service, name, err := parseRef(ref)
	if err != nil {
		return "", err
	}
	if r.clientToken == "" {
		return "", fmt.Errorf("no Hermes client token (~/.hermes/client.token) — cannot resolve %s", ref)
	}

	isCred := strings.HasPrefix(ref, CredRefPrefix)
	var url string
	if isCred {
		url = fmt.Sprintf("%s/cred/%s/%s", r.brokerURL, service, name)
	} else {
		url = fmt.Sprintf("%s/token/%s/%s", r.brokerURL, service, name)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+r.clientToken)

	resp, err := r.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("broker unreachable at %s: %w", r.brokerURL, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode != http.StatusOK {
		// Surface the broker's error code/message but NEVER any secret material.
		return "", fmt.Errorf("broker returned %d for %s/%s: %s", resp.StatusCode, service, name, brokerErrSummary(body))
	}

	if isCred {
		var cred struct {
			Value string `json:"value"`
		}
		if err := json.Unmarshal(body, &cred); err != nil {
			return "", fmt.Errorf("broker /cred response for %s/%s not valid JSON", service, name)
		}
		if cred.Value == "" {
			return "", fmt.Errorf("broker /cred response for %s/%s had no value", service, name)
		}
		return cred.Value, nil
	}

	var bundle struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.Unmarshal(body, &bundle); err != nil {
		return "", fmt.Errorf("broker response for %s/%s not valid JSON", service, name)
	}
	if bundle.AccessToken == "" {
		return "", fmt.Errorf("broker response for %s/%s had no accessToken", service, name)
	}
	return bundle.AccessToken, nil
}

// brokerErrSummary extracts the non-sensitive {code,message} from a broker error
// body without echoing any secret material.
func brokerErrSummary(body []byte) string {
	var e struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &e) == nil && (e.Code != "" || e.Message != "") {
		return strings.TrimSpace(e.Code + " " + e.Message)
	}
	return "unrecognized broker error"
}
