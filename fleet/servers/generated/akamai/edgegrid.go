// EdgeGrid EG1-HMAC-SHA256 request signing for the Akamai API, plus three-tier
// credential resolution and a signed HTTP send.
//
// Credential resolution order (see loadCreds), highest priority first:
//
//  1. The Hermes broker, GET /cred/{service}/{account}. The broker URL defaults
//     to the loopback broker (HERMES_URL overrides) and the client token comes
//     from HERMES_CLIENT_TOKEN or ~/.hermes/client.token, so no secret needs to
//     live in the fleet manifest. EdgeGrid needs four fields but the broker
//     serves one opaque string per account, so the four fields are four
//     ACCOUNTS under the single service "akamai": host, client_token,
//     client_secret, access_token, plus the optional account_key. This fits the
//     existing broker contract with no hermes-side change.
//  2. AKAMAI_* environment variables.
//  3. The ~/.edgerc INI file.
//
// A partial Hermes result (some accounts present, others missing) is treated as
// a MISS and falls through to the next tier rather than assembling a half
// credential. A half credential signs a request that fails as an opaque 401,
// which is precisely the failure mode this ordering exists to avoid. The same
// rule applies to the env tier. The practical consequence of the ordering is
// that an EMPTY VAULT changes nothing: the broker lookup misses and resolution
// lands on .edgerc exactly as it did before Hermes was wired in.
//
// The signing algorithm is the Akamai EdgeGrid spec, matched byte-for-byte
// against the reference implementations (akamai-edgegrid Node lib, edgegrid-python):
//
//	signing_key   = base64(HMAC-SHA256(client_secret, timestamp))
//	data_to_sign  = METHOD \t https \t host \t relativeURL \t canonHeaders \t contentHash \t authHeader
//	signature     = base64(HMAC-SHA256(signing_key, data_to_sign))
//	Authorization = authHeader + "signature=" + signature
//
// where authHeader = "EG1-HMAC-SHA256 client_token=..;access_token=..;timestamp=..;nonce=..;"
// canonHeaders is empty (no headers signed by default) and contentHash is
// base64(SHA256(body)) for POST bodies only (else empty).
//
// Credentials are NEVER logged, echoed, or returned in any tool result or error.
package main

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// edgeGridMaxBody is the byte cap applied to a POST body before hashing for the
// content hash, per the EdgeGrid spec's max-body limit. Akamai's default is
// 131072 bytes; bodies larger than this are truncated for the hash only.
const edgeGridMaxBody = 131072

// edgercCreds holds the four EdgeGrid credential fields. host has no scheme.
type edgercCreds struct {
	host         string
	clientToken  string
	clientSecret string
	accessToken  string
	accountKey   string // optional account-switch-key
}

// Hermes credential coordinates. EdgeGrid's four fields are four accounts under
// one service, because the broker serves a single opaque string per account.
const (
	hermesService = "akamai"

	hermesAcctHost         = "host"
	hermesAcctClientToken  = "client_token"
	hermesAcctClientSecret = "client_secret"
	hermesAcctAccessToken  = "access_token"
	hermesAcctAccountKey   = "account_key" // optional
)

// hermesTimeout bounds a broker lookup. The broker is a loopback service, so a
// slow answer means something is wrong; failing fast and falling through to the
// next tier is better than stalling startup or a tool call.
const hermesTimeout = 5 * time.Second

var hermesClient = &http.Client{Timeout: hermesTimeout}

// defaultHermesURL is the loopback broker. HERMES_URL overrides it.
const defaultHermesURL = "http://127.0.0.1:9876"

// hermesBrokerURL returns the broker base URL, defaulting to loopback.
func hermesBrokerURL() string {
	if v := strings.TrimSpace(os.Getenv("HERMES_URL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return defaultHermesURL
}

// hermesClientToken returns the broker client token: HERMES_CLIENT_TOKEN when
// set, otherwise the contents of ~/.hermes/client.token.
//
// The file fallback is what keeps the fleet manifest free of secrets, and it
// matches the convention the other Hermes-authoritative servers in this fleet
// already use (datastream2-go, venafi-go). The shodan-go reference requires the
// env var instead, but shodan receives its credential through a hermescred://
// manifest ref, which is not a safe mechanism here (see the note in the akamai
// manifest block). Returns "" when no token can be read, which makes the whole
// Hermes tier a silent miss.
func hermesClientToken() string {
	if v := strings.TrimSpace(os.Getenv("HERMES_CLIENT_TOKEN")); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(home, ".hermes", "client.token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// fetchCredFromHermes reads one account's value from the local Hermes broker.
// It returns "" (never an error) when the broker is not configured, is
// unreachable, 404s, or returns anything unexpected, so every caller falls
// through silently to the next resolution tier. It never logs the value.
func fetchCredFromHermes(ctx context.Context, account string) string {
	token := hermesClientToken()
	if token == "" {
		return ""
	}
	base := hermesBrokerURL()
	reqURL := base + "/cred/" + hermesService + "/" + account
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := hermesClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "" // includes the 404 the broker returns for an unenrolled account
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return ""
	}
	var cred struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(body, &cred); err != nil {
		return ""
	}
	return cred.Value
}

// credsFromHermes assembles a complete credential from the broker, or returns
// nil. Partial results are deliberately discarded: signing with a half
// credential produces an opaque 401 that is far harder to diagnose than simply
// falling through to the next tier.
func credsFromHermes(ctx context.Context) *edgercCreds {
	if hermesClientToken() == "" {
		return nil // no broker token available: a miss, not a failure
	}
	c := &edgercCreds{
		host:         normalizeHost(fetchCredFromHermes(ctx, hermesAcctHost)),
		clientToken:  fetchCredFromHermes(ctx, hermesAcctClientToken),
		clientSecret: fetchCredFromHermes(ctx, hermesAcctClientSecret),
		accessToken:  fetchCredFromHermes(ctx, hermesAcctAccessToken),
		accountKey:   fetchCredFromHermes(ctx, hermesAcctAccountKey), // optional
	}
	if !c.complete() {
		return nil
	}
	return c
}

// complete reports whether all four required EdgeGrid fields are present. The
// account key is optional and is not considered.
func (c *edgercCreds) complete() bool {
	return c != nil && c.host != "" && c.clientToken != "" && c.clientSecret != "" && c.accessToken != ""
}

// credsFromEnv assembles a complete credential from AKAMAI_* environment
// variables, or returns nil. Partial env configuration is a miss for the same
// reason as a partial Hermes result.
func credsFromEnv() *edgercCreds {
	c := &edgercCreds{
		host:         normalizeHost(os.Getenv("AKAMAI_HOST")),
		clientToken:  os.Getenv("AKAMAI_CLIENT_TOKEN"),
		clientSecret: os.Getenv("AKAMAI_CLIENT_SECRET"),
		accessToken:  os.Getenv("AKAMAI_ACCESS_TOKEN"),
		accountKey:   os.Getenv("AKAMAI_ACCOUNT_KEY"),
	}
	if !c.complete() {
		return nil
	}
	return c
}

// loadCreds resolves EdgeGrid credentials in three tiers: the Hermes broker,
// then AKAMAI_* environment variables, then the ~/.edgerc INI file (section
// AKAMAI_EDGERC_SECTION, default "default"; path overridable with
// AKAMAI_EDGERC). Returns an error only when no tier yields a complete set.
//
// The ordering is what makes enabling Hermes a no-op for an operator who has
// not enrolled anything: an empty vault misses and .edgerc still wins.
// The returned values are secret and are never logged.
func loadCreds(ctx context.Context) (*edgercCreds, error) {
	// 1. Hermes broker (four accounts under service "akamai").
	if c := credsFromHermes(ctx); c != nil {
		return c, nil
	}

	// 2. Full env-var credential set.
	if c := credsFromEnv(); c != nil {
		return c, nil
	}

	// 3. ~/.edgerc INI, chosen section.
	path := os.Getenv("AKAMAI_EDGERC")
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("cannot resolve home dir for .edgerc: %w", err)
		}
		path = filepath.Join(home, ".edgerc")
	}
	section := os.Getenv("AKAMAI_EDGERC_SECTION")
	if section == "" {
		section = "default"
	}
	c, err := parseEdgerc(path, section)
	if err != nil {
		return nil, err
	}
	// Allow an env account-switch-key to override the file.
	if k := os.Getenv("AKAMAI_ACCOUNT_KEY"); k != "" {
		c.accountKey = k
	}
	return c, nil
}

// parseEdgerc reads a minimal INI file and returns the credentials from the
// named section. It understands "[section]" headers and "key = value" lines.
func parseEdgerc(path, section string) (*edgercCreds, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("cannot open .edgerc at %s: %w", path, err)
	}
	defer f.Close()

	cur := ""
	vals := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			cur = strings.TrimSpace(line[1 : len(line)-1])
			continue
		}
		if cur != section {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		vals[strings.ToLower(key)] = val
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("error reading .edgerc: %w", err)
	}

	c := &edgercCreds{
		host:         normalizeHost(vals["host"]),
		clientToken:  vals["client_token"],
		clientSecret: vals["client_secret"],
		accessToken:  vals["access_token"],
		accountKey:   vals["account_key"], // also 'account-switch-key' below
	}
	if c.accountKey == "" {
		c.accountKey = vals["account-switch-key"]
	}
	if c.host == "" || c.clientToken == "" || c.clientSecret == "" || c.accessToken == "" {
		return nil, fmt.Errorf(".edgerc section [%s] is missing one or more required fields (host, client_token, client_secret, access_token)", section)
	}
	return c, nil
}

// normalizeHost strips any scheme and trailing slash from an EdgeGrid host.
func normalizeHost(h string) string {
	h = strings.TrimSpace(h)
	h = strings.TrimPrefix(h, "https://")
	h = strings.TrimPrefix(h, "http://")
	return strings.TrimRight(h, "/")
}

// egTimestamp returns the current UTC time in EdgeGrid's required format:
// yyyyMMddTHH:mm:ss+0000.
func egTimestamp() string {
	return time.Now().UTC().Format("20060102T15:04:05-0700")
}

// egNonce returns a random hex nonce.
func egNonce() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failure is catastrophic; fall back to a timestamp-derived
		// value so a request can still be attempted rather than panicking.
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(b)
}

func base64HMACSHA256(key, msg string) string {
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte(msg))
	return base64.StdEncoding.EncodeToString(m.Sum(nil))
}

func base64SHA256(b []byte) string {
	h := sha256.Sum256(b)
	return base64.StdEncoding.EncodeToString(h[:])
}

// signRequest computes the EG1-HMAC-SHA256 Authorization header value for the
// given request. relativeURL must be the path plus (optional) "?query" exactly
// as it appears on the wire. body is the raw request body (may be nil).
func (c *edgercCreds) signRequest(method, relativeURL string, body []byte) string {
	timestamp := egTimestamp()
	nonce := egNonce()

	authHeader := "EG1-HMAC-SHA256 " +
		"client_token=" + c.clientToken + ";" +
		"access_token=" + c.accessToken + ";" +
		"timestamp=" + timestamp + ";" +
		"nonce=" + nonce + ";"

	// Content hash: POST bodies only, per EdgeGrid spec.
	contentHash := ""
	if strings.EqualFold(method, http.MethodPost) && len(body) > 0 {
		b := body
		if len(b) > edgeGridMaxBody {
			b = b[:edgeGridMaxBody]
		}
		contentHash = base64SHA256(b)
	}

	// Tab-separated data-to-sign. canonicalizedHeaders is empty (no signed headers).
	dataToSign := strings.Join([]string{
		strings.ToUpper(method),
		"https",
		strings.ToLower(c.host),
		relativeURL,
		"", // canonicalized request headers (none)
		contentHash,
		authHeader,
	}, "\t")

	signingKey := base64HMACSHA256(c.clientSecret, timestamp)
	signature := base64HMACSHA256(signingKey, dataToSign)

	return authHeader + "signature=" + signature
}

// signedResponse is the normalized result of a signed API call.
type signedResponse struct {
	StatusCode int
	Body       []byte
	Headers    http.Header
}

// doSigned performs a signed EdgeGrid request. path is the API path beginning
// with "/". query holds URL query parameters (the account-switch-key is added
// automatically when configured). headers are extra request headers (subject to
// the caller's allowlist). body may be nil. The Authorization header is computed
// over the exact relative URL sent, so query ordering is fixed here.
func (c *edgercCreds) doSigned(client *http.Client, method, path string, query url.Values, headers map[string]string, body []byte) (*signedResponse, error) {
	// Credential resolution is no longer fatal at startup, so this is the one
	// chokepoint every signed request crosses and therefore the right place to
	// fail legibly instead of panicking on a nil receiver. Names the resolution
	// order so the operator knows what to fix; never names a value.
	if c == nil {
		return nil, fmt.Errorf("no EdgeGrid credentials resolved: tried the Hermes broker " +
			"(HERMES_URL plus HERMES_CLIENT_TOKEN, service \"akamai\"), then AKAMAI_* env vars, " +
			"then the .edgerc file. Enroll with `hermes creds set akamai <field>` or provide .edgerc")
	}
	if query == nil {
		query = url.Values{}
	}
	if c.accountKey != "" && query.Get("accountSwitchKey") == "" {
		query.Set("accountSwitchKey", c.accountKey)
	}

	relativeURL := path
	if enc := query.Encode(); enc != "" {
		relativeURL = path + "?" + enc
	}

	fullURL := "https://" + c.host + relativeURL
	var bodyReader io.Reader
	if len(body) > 0 {
		bodyReader = strings.NewReader(string(body))
	}
	req, err := http.NewRequest(method, fullURL, bodyReader)
	if err != nil {
		return nil, err
	}

	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if len(body) > 0 && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "application/json")
	}
	req.Header.Set("Authorization", c.signRequest(method, relativeURL, body))

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	rb, err := io.ReadAll(io.LimitReader(resp.Body, maxRespBody))
	if err != nil {
		return nil, err
	}
	return &signedResponse{StatusCode: resp.StatusCode, Body: rb, Headers: resp.Header}, nil
}
