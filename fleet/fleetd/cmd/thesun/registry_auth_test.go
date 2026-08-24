package main

import "testing"

// TestStashAuthApplies locks the credential boundary: the Stash PAT is attached
// ONLY to an https URL whose host exactly matches the configured Stash host. A
// plaintext http downgrade, a foreign host, or an unset host must all refuse the
// token so it is never leaked in cleartext or sent to the wrong server.
func TestStashAuthApplies(t *testing.T) {
	const host = "stash.example.net"
	cases := []struct {
		name string
		url  string
		host string
		want bool
	}{
		{"https exact host", "https://stash.example.net/rest/downloads/x", host, true},
		{"https host case-insensitive", "https://STASH.Example.Net/x", host, true},
		{"http downgrade refused", "http://stash.example.net/x", host, false},
		{"foreign host refused", "https://evil.example.com/x", host, false},
		{"foreign host that only suffixes refused", "https://notstash.example.net.evil.com/x", host, false},
		{"empty configured host disables", "https://stash.example.net/x", "", false},
		{"file url refused", "file:///tmp/x", host, false},
		{"garbage url refused", "::::", host, false},
		{"host in path not authority refused", "https://evil.com/stash.example.net", host, false},
	}
	for _, c := range cases {
		if got := stashAuthApplies(c.url, c.host); got != c.want {
			t.Errorf("%s: stashAuthApplies(%q, %q) = %v, want %v", c.name, c.url, c.host, got, c.want)
		}
	}
}
