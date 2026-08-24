package registry

import (
	"bytes"
	"testing"
)

func sampleVersion() (string, *Version) {
	return "demo", &Version{
		Version: "0.1.0",
		Status:  "released",
		Platforms: []Platform{
			// Intentionally out of sorted order to prove CanonicalBytes sorts.
			{OS: "linux", Arch: "amd64", SHA256: "bbbb"},
			{OS: "darwin", Arch: "arm64", SHA256: "aaaa"},
		},
	}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	pub, priv, err := GenerateKeypair()
	if err != nil {
		t.Fatalf("GenerateKeypair: %v", err)
	}
	name, v := sampleVersion()
	msg := CanonicalBytes(name, v)

	sig := Sign(priv, msg)
	if !Verify(pub, msg, sig) {
		t.Fatal("Verify failed for a freshly signed message")
	}
}

func TestVerifyRejectsTamperedMessage(t *testing.T) {
	pub, priv, err := GenerateKeypair()
	if err != nil {
		t.Fatalf("GenerateKeypair: %v", err)
	}
	name, v := sampleVersion()
	msg := CanonicalBytes(name, v)
	sig := Sign(priv, msg)

	// Flip a single byte of the message: verification must fail.
	tampered := append([]byte(nil), msg...)
	tampered[len(tampered)/2] ^= 0x01
	if Verify(pub, tampered, sig) {
		t.Fatal("Verify accepted a single-byte-tampered message")
	}

	// Tamper the signed digest instead (a swapped binary): a new canonical
	// message no longer matches the old signature.
	v2 := &Version{Version: v.Version, Platforms: []Platform{
		{OS: "linux", Arch: "amd64", SHA256: "cccc"},
		{OS: "darwin", Arch: "arm64", SHA256: "aaaa"},
	}}
	if Verify(pub, CanonicalBytes(name, v2), sig) {
		t.Fatal("Verify accepted a message with a swapped binary digest")
	}
}

func TestVerifyRejectsWrongKey(t *testing.T) {
	_, priv, _ := GenerateKeypair()
	otherPub, _, _ := GenerateKeypair()
	name, v := sampleVersion()
	msg := CanonicalBytes(name, v)
	sig := Sign(priv, msg)

	if Verify(otherPub, msg, sig) {
		t.Fatal("Verify accepted a signature under the wrong public key")
	}
}

func TestVerifyFailsClosedOnGarbage(t *testing.T) {
	pub, _, _ := GenerateKeypair()
	name, v := sampleVersion()
	msg := CanonicalBytes(name, v)

	if Verify(pub, msg, "") {
		t.Fatal("Verify accepted an empty signature")
	}
	if Verify(pub, msg, "not-base64-!!!") {
		t.Fatal("Verify accepted a non-base64 signature")
	}
	if Verify([]byte{1, 2, 3}, msg, Sign(mustPriv(t), msg)) {
		t.Fatal("Verify accepted a wrong-length public key")
	}
}

func TestCanonicalBytesIsDeterministicAndOrderIndependent(t *testing.T) {
	name := "demo"
	a := &Version{Version: "0.1.0", Platforms: []Platform{
		{OS: "linux", Arch: "amd64", SHA256: "bb"},
		{OS: "darwin", Arch: "arm64", SHA256: "aa"},
	}}
	b := &Version{Version: "0.1.0", Platforms: []Platform{
		{OS: "darwin", Arch: "arm64", SHA256: "aa"},
		{OS: "linux", Arch: "amd64", SHA256: "bb"},
	}}
	if !bytes.Equal(CanonicalBytes(name, a), CanonicalBytes(name, b)) {
		t.Fatal("CanonicalBytes is sensitive to platform ordering; it must sort")
	}
}

func TestEncodeDecodeKey(t *testing.T) {
	pub, _, _ := GenerateKeypair()
	enc := EncodeKey(pub)
	got, err := DecodeKey(enc + "\n") // trailing newline (key-file shape) tolerated
	if err != nil {
		t.Fatalf("DecodeKey: %v", err)
	}
	if !bytes.Equal(got, pub) {
		t.Fatal("Decode(Encode(k)) != k")
	}
	if _, err := DecodeKey(""); err == nil {
		t.Fatal("DecodeKey(\"\") should error")
	}
}

func mustPriv(t *testing.T) []byte {
	t.Helper()
	_, priv, err := GenerateKeypair()
	if err != nil {
		t.Fatalf("GenerateKeypair: %v", err)
	}
	return priv
}
