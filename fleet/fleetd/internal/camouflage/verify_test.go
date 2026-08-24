package camouflage

import (
	"strings"
	"testing"
)

func TestVerify_MissingFile(t *testing.T) {
	ok, detail := Verify(t.TempDir())
	if ok {
		t.Fatal("Verify on empty dir: want ok=false")
	}
	if !strings.Contains(detail, "unreadable") {
		t.Fatalf("detail = %q, want mention of unreadable file", detail)
	}
}

func TestVerify_GoodProfile(t *testing.T) {
	dir := t.TempDir()
	p := buildProfile("macos", "chrome", "131.0.6778.109")
	if err := WriteConfig(dir, p); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}
	ok, detail := Verify(dir)
	if !ok {
		t.Fatalf("Verify on a good profile: want ok=true, got false (%s)", detail)
	}
}

func TestVerify_CatchesOSMismatchedUserAgent(t *testing.T) {
	dir := t.TempDir()
	// Profile claims macOS but carries a Windows-flavored UA — exactly the
	// defect Verify exists to catch (a profile that would make a generated
	// server's traffic self-contradictory: "I'm on macOS" TLS/OS-level
	// signals next to a Windows User-Agent string).
	bad := Profile{
		OS:          "macos",
		Browser:     "chrome",
		Impersonate: "chrome131",
		TLSProfile:  "HelloChrome_131",
		UserAgent:   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	}
	if err := WriteConfig(dir, bad); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}
	ok, detail := Verify(dir)
	if ok {
		t.Fatal("Verify on an OS-mismatched UA: want ok=false, got true")
	}
	if !strings.Contains(detail, "mismatch") {
		t.Fatalf("detail = %q, want mention of the OS/UA mismatch", detail)
	}
}

func TestVerify_CatchesMissingImpersonate(t *testing.T) {
	dir := t.TempDir()
	p := Profile{
		OS:        "linux",
		Browser:   "unknown",
		UserAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		// Impersonate / TLSProfile deliberately left empty.
	}
	if err := WriteConfig(dir, p); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}
	ok, _ := Verify(dir)
	if ok {
		t.Fatal("Verify with empty impersonate/tls_profile: want ok=false, got true")
	}
}
