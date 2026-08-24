package camouflage

import (
	"strings"
	"testing"
)

func TestBuildProfile_OSTokenMatchesHostForEveryGOOS(t *testing.T) {
	cases := []struct {
		osName    string
		wantToken string
	}{
		{"macos", "Mac OS X"},
		{"linux", "Linux"},
		{"windows", "Windows NT"},
	}
	for _, tc := range cases {
		t.Run(tc.osName, func(t *testing.T) {
			p := buildProfile(tc.osName, "chrome", "124.0.6367.91")
			if p.OS != tc.osName {
				t.Fatalf("OS = %q, want %q", p.OS, tc.osName)
			}
			if !strings.Contains(p.UserAgent, tc.wantToken) {
				t.Fatalf("user_agent %q does not contain expected OS token %q", p.UserAgent, tc.wantToken)
			}
		})
	}
}

func TestBuildProfile_UnknownBrowserStillMatchesHostOS(t *testing.T) {
	for _, osName := range []string{"macos", "linux", "windows"} {
		p := buildProfile(osName, "", "")
		if p.Browser != "unknown" {
			t.Fatalf("Browser = %q, want %q", p.Browser, "unknown")
		}
		if p.Impersonate != defaultImpersonate {
			t.Fatalf("Impersonate = %q, want default %q", p.Impersonate, defaultImpersonate)
		}
		if p.TLSProfile != defaultTLSProfile {
			t.Fatalf("TLSProfile = %q, want default %q", p.TLSProfile, defaultTLSProfile)
		}
		if !strings.Contains(p.UserAgent, osToken(osName)) {
			t.Fatalf("os=%s: user_agent %q missing OS token %q", osName, p.UserAgent, osToken(osName))
		}
	}
}

func TestMapBrowser_ChromeNearestFloor(t *testing.T) {
	cases := []struct {
		version         string
		wantImpersonate string
		wantTLS         string
	}{
		{"150.0.7871.47", "chrome146", "HelloChrome_133"}, // above every anchor -> newest
		{"131.0.6778.109", "chrome131", "HelloChrome_131"},
		{"100.0.4896.60", "chrome100", "HelloChrome_100"},
		{"58.0.0.0", "chrome99", "HelloChrome_58"}, // below every curl_cffi anchor -> its floor
		{"", "chrome146", "HelloChrome_133"},       // undetected version -> newest/default
	}
	for _, tc := range cases {
		imp, tls := mapBrowser("chrome", tc.version)
		if imp != tc.wantImpersonate {
			t.Errorf("version=%q: impersonate = %q, want %q", tc.version, imp, tc.wantImpersonate)
		}
		if tls != tc.wantTLS {
			t.Errorf("version=%q: tlsProfile = %q, want %q", tc.version, tls, tc.wantTLS)
		}
	}
}

func TestMapBrowser_EdgeAlwaysNewest(t *testing.T) {
	imp, tls := mapBrowser("edge", "149.0.4022.98")
	if imp != "edge101" || tls != "HelloEdge_106" {
		t.Fatalf("edge mapping = (%q, %q), want (edge101, HelloEdge_106)", imp, tls)
	}
}

func TestMapBrowser_Safari(t *testing.T) {
	cases := []struct {
		version         string
		wantImpersonate string
	}{
		{"26.3.1", "safari2601"},
		{"18.1", "safari180"},
		{"17.0", "safari170"},
		{"15.5", "safari155"},
		{"", "safari180"},
	}
	for _, tc := range cases {
		imp, tls := mapBrowser("safari", tc.version)
		if imp != tc.wantImpersonate {
			t.Errorf("version=%q: impersonate = %q, want %q", tc.version, imp, tc.wantImpersonate)
		}
		if tls != "HelloSafari_16_0" {
			t.Errorf("version=%q: tlsProfile = %q, want HelloSafari_16_0", tc.version, tls)
		}
	}
}

func TestMapBrowser_UnknownFallsBackToChromeDefault(t *testing.T) {
	imp, tls := mapBrowser("some-obscure-firefox-fork", "125.0")
	if imp != defaultImpersonate || tls != defaultTLSProfile {
		t.Fatalf("unknown-browser mapping = (%q, %q), want (%q, %q)", imp, tls, defaultImpersonate, defaultTLSProfile)
	}
}

func TestBuildUserAgent_EdgeIncludesEdgToken(t *testing.T) {
	ua := buildUserAgent("windows", "edge", "120.0.6099.129")
	if !strings.Contains(ua, "Edg/120.0.6099.129") {
		t.Fatalf("edge UA missing Edg/ token: %q", ua)
	}
	if !strings.Contains(ua, "Windows NT") {
		t.Fatalf("edge UA missing Windows OS token: %q", ua)
	}
}

func TestBuildUserAgent_SafariUsesVersionToken(t *testing.T) {
	ua := buildUserAgent("macos", "safari", "17.4")
	if !strings.Contains(ua, "Version/17.4") {
		t.Fatalf("safari UA missing Version/ token: %q", ua)
	}
	if strings.Contains(ua, "Chrome/") {
		t.Fatalf("safari UA should not contain a Chrome/ token: %q", ua)
	}
}

func TestMajorVersion(t *testing.T) {
	cases := map[string]int{
		"131.0.6778.109": 131,
		"17.0":           17,
		"":               0,
		"not-a-version":  0,
		"26":             26,
	}
	for in, want := range cases {
		if got := majorVersion(in); got != want {
			t.Errorf("majorVersion(%q) = %d, want %d", in, got, want)
		}
	}
}
