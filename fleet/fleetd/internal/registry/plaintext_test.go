package registry

import "testing"

// TestPlaintextHTTPAllowed pins the transport policy: plaintext http is refused
// for remote hosts (it defeats the sha256 integrity chain for an unsigned
// community entry, since the attacker who rewrites the bytes also serves the
// index), but permitted for loopback, where there is no exposure and where a
// local index and offline testing depend on it.
func TestPlaintextHTTPAllowed(t *testing.T) {
	cases := []struct {
		ref  string
		want bool
	}{
		{"https://example.com/index.toml", true},
		{"file:///tmp/index.toml", true},
		{"/tmp/index.toml", true},
		{"http://127.0.0.1:8080/index.toml", true},
		{"http://localhost:8080/index.toml", true},
		{"http://[::1]:8080/index.toml", true},
		{"http://example.com/index.toml", false},
		{"http://192.168.1.10/index.toml", false},
		{"http://10.0.0.5:9000/index.toml", false},
		{"http://%zz/index.toml", false}, // unparseable plaintext URL fails closed
	}
	for _, c := range cases {
		if got := PlaintextHTTPAllowed(c.ref); got != c.want {
			t.Errorf("PlaintextHTTPAllowed(%q) = %v, want %v", c.ref, got, c.want)
		}
	}
}

// TestFetchIndexRefusesRemotePlaintext proves the refusal happens at the fetch
// boundary, not just in the predicate.
func TestFetchIndexRefusesRemotePlaintext(t *testing.T) {
	_, _, err := FetchIndex(nil, "http://example.com/index.toml")
	if err == nil {
		t.Fatal("FetchIndex accepted a remote plaintext http index; it must refuse")
	}
}
