package registry

// sign.go is the trust primitive for the store: the maintainer (or a community
// author) signs a version's identity plus its exact per-platform binary digests
// with an Ed25519 private key, and `thesun add` verifies that signature against
// a trusted public key before it will install anything. This is what makes a
// checksum meaningful: sha256 alone proves the bytes match the index, but only
// the signature proves the index line itself was not tampered with by whoever
// served it.

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"strings"
)

// GenerateKeypair returns a fresh Ed25519 (public, private) keypair. The private
// key is 64 bytes (seed+public per crypto/ed25519); the public key is 32 bytes.
func GenerateKeypair() (pub, priv []byte, err error) {
	pubKey, privKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		return nil, nil, err
	}
	return pubKey, privKey, nil
}

// CanonicalBytes produces the DETERMINISTIC message signed over a version. The
// exact wire format (newline-terminated lines, in this fixed order) is:
//
//	thesun-registry/v1\n
//	entry=<entryName>\n
//	version=<v.Version>\n
//	<os>/<arch> <sha256>\n      (one line per platform, sorted by os then arch)
//
// Only the fields that establish binary identity are covered: the entry name,
// the semver, and each platform's os/arch plus its lowercase-hex sha256. The
// platform lines are sorted so the message is independent of the order the
// platforms happen to appear in the TOML. Any change to a binary digest, an
// added or removed platform, the version string, or the entry name changes the
// message and therefore invalidates the signature.
func CanonicalBytes(entryName string, v *Version) []byte {
	var b strings.Builder
	b.WriteString("thesun-registry/v1\n")
	b.WriteString("entry=" + entryName + "\n")
	b.WriteString("version=" + v.Version + "\n")
	for _, p := range v.sortedPlatforms() {
		b.WriteString(p.OS + "/" + p.Arch + " " + strings.ToLower(p.SHA256) + "\n")
	}
	return []byte(b.String())
}

// Sign returns the base64 (std encoding) Ed25519 signature of msg under priv.
func Sign(priv []byte, msg []byte) string {
	sig := ed25519.Sign(ed25519.PrivateKey(priv), msg)
	return base64.StdEncoding.EncodeToString(sig)
}

// Verify reports whether sigB64 is a valid Ed25519 signature of msg under pub.
// It fails closed: a malformed key, a malformed/empty signature, or a wrong
// length all return false rather than an error.
func Verify(pub []byte, msg []byte, sigB64 string) bool {
	if len(pub) != ed25519.PublicKeySize {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(sigB64))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(pub), msg, sig)
}

// EncodeKey renders a raw key (public or private) as base64 std text for storage
// in a file or the compiled-in trust constant.
func EncodeKey(key []byte) string {
	return base64.StdEncoding.EncodeToString(key)
}

// DecodeKey parses base64 std text back into raw key bytes. Whitespace is
// trimmed so a trailing newline in a key file is tolerated.
func DecodeKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("empty key")
	}
	return base64.StdEncoding.DecodeString(s)
}
