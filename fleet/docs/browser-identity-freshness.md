# Browser Identity Freshness

**Status:** Design (forward-looking). No anti-bot targets exist in the fleet yet.
**Build trigger (KISS gate):** Implement **only when the first MCP server that must defeat active bot management (Akamai / Cloudflare / PerimeterX) enters the fleet.** Until then this document is the plan of record and nothing is built.
**Date:** 2026-07-04
**Scope:** Cross-runtime concern for browser-realistic MCP servers — Go (`bogdanfinn/tls-client`) and Python (`curl_cffi`).

---

## 1. Problem

A future class of MCP servers will need to talk to origins sitting behind bot-management platforms. Those platforms fingerprint the client at multiple layers simultaneously and reject any client whose layers disagree with each other or with the population of real browsers:

- **TLS ClientHello** — JA3 / JA4 (cipher list, extensions, curves, ALPN, signature algorithms).
- **HTTP/2** — SETTINGS frame values, WINDOW_UPDATE, pseudo-header order, header order.
- **User-Agent string** — declared browser + version + platform.
- **UA Client Hints** — `Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform`, `Sec-CH-UA-Platform-Version`, `Sec-CH-UA-Full-Version-List`.
- **Accept family** — `Accept`, `Accept-Language`, `Accept-Encoding`.

Two runtimes must produce clients that agree at every one of those layers, and must keep agreeing as the operator's real browser auto-updates roughly monthly. The operator's directive:

> "at configuration time, when someone sets this up on their machine, the fingerprint should match the version of whatever browser they actually use, and update as that browser updates — don't throw around stale UAs / old TLS matches."

---

## 2. Central Principle

**Consistency > freshness, and staleness breaks consistency.**

Every layer must describe *the same real browser + version + OS*. A UA that claims Chrome 150 riding on a TLS ClientHello that is unmistakably Chrome 131 is an instant bot tell — bot managers maintain JA3/JA4 → expected-UA-version maps and cross-check them. Therefore the deliverable is a **single "browser identity" object** that is the sole source of truth; TLS profile, HTTP/2 profile, UA, client hints, and Accept headers are all *derived from it*, never chosen independently.

**Corollary that resolves the whole design (see §5 and §11):** the identity's authoritative version is **the version the TLS layer can actually reproduce** (the nearest supported library profile), *not* the locally-installed browser version. The locally-detected version only (a) selects which profile to pin and (b) computes a *staleness gap* for observability. We never let the UA claim a version the TLS layer cannot mimic — internal coherence beats literal freshness.

---

## 3. Detection (setup time + start-of-run)

Goal: determine the operator's **default / primary browser, its precise version, and the machine OS + version + arch** using only read-only, offline, no-dependency probes.

### 3.1 macOS

Version via the app bundle `Info.plist` — reliable, no launch required:

```bash
# Chrome
defaults read "/Applications/Google Chrome.app/Contents/Info.plist" CFBundleShortVersionString
# Safari (system app on modern macOS)
defaults read "/Applications/Safari.app/Contents/Info.plist" CFBundleShortVersionString \
  || defaults read "/System/Applications/Safari.app/Contents/Info.plist" CFBundleShortVersionString
# Edge / Firefox / Brave — same pattern, different bundle path
defaults read "/Applications/Microsoft Edge.app/Contents/Info.plist" CFBundleShortVersionString
defaults read "/Applications/Firefox.app/Contents/Info.plist" CFBundleShortVersionString
defaults read "/Applications/Brave Browser.app/Contents/Info.plist" CFBundleShortVersionString
```

OS + arch:

```bash
sw_vers                 # ProductVersion = 26.3.1, BuildVersion = ...
uname -m                # arm64 | x86_64
```

Default browser (the handler bound to `https`) — parse LaunchServices:

```bash
plutil -convert xml1 -o - \
  ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist \
  | grep -B1 -A2 'httpsURL' | grep LSHandlerRoleAll
# yields a bundle id, e.g. com.google.chrome → map to a browser family
```

`mdls -name kMDItemVersion "/Applications/Google Chrome.app"` is a secondary cross-check.

### 3.2 Linux

```bash
google-chrome --version         # "Google Chrome 150.0.7871.47"
google-chrome-stable --version
microsoft-edge --version
firefox --version               # "Mozilla Firefox 152.0.4"
# Package-manager fallbacks:
dpkg -s google-chrome-stable | grep ^Version     # Debian/Ubuntu
rpm -q google-chrome-stable                       # Fedora/RHEL
pacman -Qi google-chrome                           # Arch (AUR)
# OS:
uname -m ; . /etc/os-release ; echo "$NAME $VERSION_ID"
# Default browser:
xdg-settings get default-web-browser              # e.g. google-chrome.desktop
```

### 3.3 Windows

```powershell
# Version via file VersionInfo (no launch):
(Get-Item "C:\Program Files\Google\Chrome\Application\chrome.exe").VersionInfo.ProductVersion
# Registry (Chrome/Edge write BLBeacon):
Get-ItemProperty 'HKCU:\Software\Google\Chrome\BLBeacon' -Name version
Get-ItemProperty 'HKCU:\Software\Microsoft\Edge\BLBeacon' -Name version
# Default browser:
Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -Name ProgId
# OS + arch:
[System.Environment]::OSVersion.Version ; $env:PROCESSOR_ARCHITECTURE
```

### 3.4 Detection cost

All probes are sub-100ms filesystem/registry reads with **no network and no third-party dependency**, so re-running them on every server start is cheap. This is what makes "update as the browser updates" free: the local browser auto-updates its bundle/registry version, and the next server start re-detects it.

---

## 4. Profile Mapping + Staleness

The two fingerprint libraries ship a **discrete, enumerated** set of browser profiles. Real Chrome ships a new major roughly every ~4 weeks; the libraries lag by weeks-to-months. So detection almost always finds a *newer* local browser than any shipped profile (this machine is a live example — see §10). The mapping strategy must handle "detected > newest profile" as the normal case, not an edge case.

### 4.1 `bogdanfinn/tls-client` (Go) — profiles

Runtime-selected via `tls_client.WithClientProfile(profiles.Chrome_146)` — a **string/struct value passed at client construction, not a compile-time build tag** ([repo](https://github.com/bogdanfinn/tls-client), [client options](https://bogdanfinn.gitbook.io/open-source-oasis/tls-client/client-options)).

- **Chrome:** `Chrome_103` … `Chrome_112`, `Chrome_116_PSK`, `Chrome_116_PSK_PQ`, `Chrome_117`, `Chrome_120`, `Chrome_124`, `Chrome_131` / `Chrome_131_PSK`, `Chrome_133` (recent default), up to **`Chrome_146` / `Chrome_146_PSK`**.
- **Firefox:** `102, 104, 105, 106, 108, 110, 117, 120, 123, 132, 146, 147`.
- **Safari:** `Safari_15_6_1`, `Safari_16_0`; **Safari iOS** `15_5, 15_6, 16_0, 17_0, 18_0, 26_0`.
- **Opera:** `89, 90, 91`. Also **OkHttp** (Android app profile family).
- Latest release **v1.15.1 (2026-06-08)**; v1.14.0 (2026-02-04) added WebSocket, HTTP/3 fingerprints for Chrome 144 / Firefox 147, Chrome 146, Safari iOS 26.0. **Actively maintained** (~35 releases). ([releases](https://github.com/bogdanfinn/tls-client/releases))

Because tls-client wraps a forked `net/http`, the **HTTP/2 fingerprint travels with the profile** — selecting `Chrome_146` sets both the uTLS ClientHello *and* the H2 SETTINGS/header-order. One selection, two layers coherent.

### 4.2 `curl_cffi` (Python, lexiforest fork) — targets

Runtime-selected via `requests.get(url, impersonate="chrome146")` — a **plain string kwarg** ([targets](https://curl-cffi.readthedocs.io/en/latest/impersonate/targets.html), [PyPI](https://pypi.org/project/curl-cffi/)).

- **Chrome:** `chrome99, 100, 101, 104, 107, 110, 116, 119, 120, 123, 124, 131, 133a, 136, 142, 145, **146**`, plus `chrome99_android`, `chrome131_android`.
- **Edge:** `edge99, edge101`.
- **Safari:** `safari153, 155, 170, 172_ios, 180, 180_ios, 184, 184_ios, 260, 260_ios, 2601`.
- **Firefox:** `firefox133, 135, 144, 147`. **Tor:** `tor145`.
- **Generic aliases** map to the newest shipped version: `impersonate="chrome"`, `"firefox"`, `"safari"`, `"chrome_android"`, `"safari_ios"`.
- Latest release **2026-04-03**; HTTP/3 fingerprints for Chrome 145/146. **Actively maintained.** A commercial [impersonate.pro](https://impersonate.pro) tier offers weekly-updated + more profiles; the OSS build is sufficient for this design.

Like tls-client, the H2 fingerprint and default header set ride with the impersonate target (curl-impersonate bundles the matching header block).

### 4.3 Nearest-supported-profile strategy

Given `detected_major` and a runtime-loaded table of each library's available majors:

1. **Exact match** → use it. `staleness_status = "exact"`, `gap = 0`.
2. **No exact match** → pick the **highest profile major ≤ detected_major** ("nearest floor"). Never round *up* to a version the operator doesn't run — an older-but-real Chrome is a valid, common fingerprint; a not-yet-released one is not. `gap = detected_major − profile_major`; `status = "near"` (gap ≤ 3) or `"degraded"` (gap ≥ 4).
3. **Detected < every profile** (very old browser) → pick the **lowest** profile and warn loudly; this is the only case where the identity version exceeds the real browser, and it should be rare.
4. **Different browser family** with no profile at all (e.g. operator's default is Safari-on-Linux — impossible, or an unsupported niche browser) → fall back to the **newest Chrome profile** and set `identity.browser = "chrome"`, because "a current Chrome" is the safest generic realistic identity. Record `detection.fell_back_from`.

The two libraries can land on **different** nearest majors (Go table vs Python table differ). That is fine and expected — each server is internally coherent with *its own* profile; the shared identity carries **both** resolved values plus the single canonical version that the UA/hints are built from. To avoid two servers hitting the same origin with two different Chrome majors, the generator computes **one canonical `identity.browser_major`** = the *minimum* of the two libraries' nearest-floor majors (the version *both* runtimes can reproduce), and derives UA + client hints from that. Each server still selects its own native profile string, but both target the same claimed major. (If only one runtime is ever used against a given origin, this constraint is moot.)

The staleness gap is **surfaced, never hidden**: `browser-identity status` prints it, server start logs it, and the self-test (§7) fails CI if `gap` exceeds a configurable ceiling (default 6 — roughly a two-quarter lag).

---

## 5. UA + Client-Hints Coherence

All HTTP-layer strings are **derived deterministically from `identity.browser_major` + `identity.platform`** — the same major the TLS profile reproduces. We do **not** fetch a random UA from a pool; a pooled UA is the classic way layers drift apart.

### 5.1 Chromium UA + client hints are algorithmic

Modern Chromium's UA is *frozen-form* and its client hints are mechanically derived from the major version — you don't need a database, you need the algorithm:

- **User-Agent** (desktop Chrome): `Mozilla/5.0 (<platform-token>) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<MAJOR>.0.0.0 Safari/537.36`. The minor/build/patch are frozen to `.0.0.0` on desktop. Platform tokens are themselves frozen: macOS → `Macintosh; Intel Mac OS X 10_15_7` (yes, even on Apple Silicon / macOS 26 — Chrome reports the frozen `10_15_7`), Windows → `Windows NT 10.0; Win64; x64`, Linux → `X11; Linux x86_64`.
- **`Sec-CH-UA`** (significant-version brand list, with a GREASE "fake brand"): e.g. `"Chromium";v="146", "Google Chrome";v="146", "Not.A/Brand";v="24"`. The GREASE brand string + position rotate per Chrome version by a **documented, reproducible algorithm** — but bot managers accept any well-formed GREASE entry, so a fixed correct-shape value per major is sufficient.
- **`Sec-CH-UA-Mobile`**: `?0` desktop / `?1` mobile (from `identity.is_mobile`).
- **`Sec-CH-UA-Platform`**: `"macOS"` | `"Windows"` | `"Linux"` | `"Android"`.
- **`Sec-CH-UA-Platform-Version`**: the client-hint platform version (note: macOS reports its *own* scheme, and Chromium historically capped/translated this — store what the matching real Chrome sends, not the raw `sw_vers`).
- **`Sec-CH-UA-Full-Version-List`**: full quad version, e.g. `"Chromium";v="146.0.7258.67", ...`. Requires a real build string for that major — the one field that benefits from a small bundled lookup (§9).
- **`Accept-Encoding`**: `gzip, deflate, br, zstd` (Chrome ≥ 123 added `zstd`); older majors drop `zstd`. `Accept` and `Accept-Language` are stable per engine (`en-US,en;q=0.9` is the safe default; the operator can override language).

Reference: [Chrome UA Client Hints](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints), [MDN `Sec-CH-UA-Full-Version-List`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-CH-UA-Full-Version-List), [chromium.org UA-CH](https://www.chromium.org/updates/ua-ch/).

### 5.2 Firefox / Safari

Non-Chromium browsers **don't send `Sec-CH-UA`** at all (client hints are a Chromium feature). For a Firefox or Safari identity the generator emits the engine-appropriate UA and Accept headers and **omits** the client-hint block entirely — emitting `Sec-CH-UA` under a Firefox UA is itself a tell.

### 5.3 Why derive, not download

The library already bundles a matching header block per profile (curl-impersonate ships them; tls-client documents them). The generator's job is to make the **UA the servers actually send** equal to the **header block the profile implies**, and to keep the *claimed major* identical across TLS, H2, UA, and hints. Deriving from one integer (`browser_major`) makes drift structurally impossible.

---

## 6. Refresh Mechanism

Recommended: **hybrid — pin at setup, re-validate on start, explicit refresh.**

| Mechanism | Role | Cost | When it fires |
|---|---|---|---|
| **(a) Setup-time generate** | Writes `~/.mcp-fleet/browser-identity.json` from live detection. Canonical pin. | one-time | `browser-identity init` at fleet install |
| **(b) Re-validate on server start** | Each server re-runs detection (§3), compares `detected_major` to the pinned identity. If the local browser moved, **regenerate in place** (cheap, offline) and log the change. If detection fails, **fall back to the pinned file** (fail-safe, never crash on a missing browser). | <100ms | every `fleetd`-supervised start |
| **(c) Explicit `refresh`** | `browser-identity refresh` re-detects + re-resolves profiles against the *current* library tables (catches the case where you upgraded `tls-client`/`curl_cffi` and a newer profile is now available for a browser that didn't move). | on demand / post-upgrade | operator, or a fleetd post-`pip`/`go get` hook |
| **(d) Periodic dataset pull** | *Rejected as default.* Only the small full-version-list lookup (§9) could go stale; ship it vendored and refresh it with the library bump, not on a timer. No always-on network dependency. |

**Key behavior — library lags the local browser (the normal case):** re-validation does **not** try to mimic a version no profile exists for. It pins the nearest floor, recomputes the staleness gap, and derives a coherent UA at the *profile's* major. The operator sees `gap: 4 (degraded)` in `status`; the servers stay internally consistent. When the library ships the newer profile, `refresh` (or the next start after an upgrade) closes the gap automatically.

This directly satisfies "update as the browser updates" (path b, free on every start) while never producing an incoherent identity when the library hasn't caught up.

---

## 7. Architecture + Config Schema

### 7.1 Where it lives — decision

**Recommendation: a single generated config file, produced by a tiny detector/generator, consumed by both runtimes. Not a service.**

Rationale (KISS, fewest moving parts):

- The data is **slow-moving** (changes only when the browser or a library updates) and **host-local** (it describes *this* machine's browser). A running service would add a network hop, a supervised process, and a failure mode for something that is fundamentally a static file re-derived occasionally.
- Hermes centralizes SSO because SSO is *interactive, stateful, and shared* (token lifetimes, browser acquisition). Browser-identity is the opposite: *static, per-host, derivable offline*. The Hermes analogy argues **against** a service here.
- A file is trivially consumable by both a Go server (`encoding/json`) and a Python server (`json.load`) with zero shared runtime.

The generator is best implemented as **a `fleetd` subcommand / small CLI** (`fleetd browser-identity {init,refresh,status,check}` or a standalone `browser-identity` binary), reusing fleetd's existing cross-platform + supervision surface. Detection logic lives once, in Go, inside fleetd; Python servers only *read* the JSON (they never detect).

```
                    ┌──────────────────────────────┐
   browser (auto-   │  fleetd browser-identity      │  detection (§3, Go, offline)
   updates monthly) │  init | refresh | status |    │  + nearest-profile resolve (§4)
        │           │  check                        │  + UA/hint derivation (§5)
        ▼           └───────────────┬───────────────┘
   Info.plist /                     │ writes (atomic)
   registry / --version             ▼
                        ~/.mcp-fleet/browser-identity.json   ← single source of truth
                                     │
                 ┌───────────────────┴───────────────────┐
                 ▼ read on start                          ▼ read on start
      Go MCP server (tls-client)              Python MCP server (curl_cffi)
      WithClientProfile(identity.tls          impersonate = identity.tls
        .go_tls_client_profile)                 .curl_cffi_target
      sets UA + Sec-CH-UA + Accept             sets UA + Sec-CH-UA + Accept
        from identity.http                       from identity.http
```

The **thesun generator** wires *both* code-generation paths to read this file so every generated browser-realistic server is coherent by construction.

### 7.2 Config schema — `~/.mcp-fleet/browser-identity.json`

```json
{
  "schema_version": 1,
  "generated_at": "2026-07-04T12:55:00Z",
  "generator_version": "0.1.0",

  "detection": {
    "method": "info_plist",
    "browser": "chrome",
    "channel": "stable",
    "version": "150.0.7871.47",
    "major": 150,
    "is_default_browser": true,
    "os": "macos",
    "os_version": "26.3.1",
    "arch": "arm64",
    "fell_back_from": null
  },

  "identity": {
    "browser": "chrome",
    "browser_major": 146,
    "engine": "chromium",
    "platform": "macOS",
    "platform_version": "15.0.0",
    "is_mobile": false,
    "architecture": "arm",
    "bitness": "64"
  },

  "tls": {
    "go_tls_client_profile": "Chrome_146",
    "curl_cffi_target": "chrome146",
    "profile_major": 146,
    "h2_fingerprint_source": "profile",
    "staleness_gap": 4,
    "staleness_status": "degraded"
  },

  "http": {
    "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    "headers": {
      "sec-ch-ua": "\"Chromium\";v=\"146\", \"Google Chrome\";v=\"146\", \"Not.A/Brand\";v=\"24\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"macOS\"",
      "sec-ch-ua-platform-version": "\"15.0.0\"",
      "sec-ch-ua-full-version-list": "\"Chromium\";v=\"146.0.7258.67\", \"Google Chrome\";v=\"146.0.7258.67\", \"Not.A/Brand\";v=\"24.0.0.0\"",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "accept-language": "en-US,en;q=0.9",
      "accept-encoding": "gzip, deflate, br, zstd"
    }
  },

  "warnings": [
    "staleness_gap=4: local Chrome 150 exceeds newest library profile 146; identity pinned to 146 for cross-layer coherence. Run `browser-identity refresh` after upgrading tls-client / curl_cffi."
  ]
}
```

Field notes:
- `detection.*` = ground truth about the machine (the real browser).
- `identity.browser_major` = **the canonical claimed version** (nearest floor both runtimes can reproduce). Everything in `http` is built from this, *not* from `detection.major`.
- `tls.*` = per-runtime profile strings + the staleness telemetry.
- `http.headers` is emitted verbatim by both servers; the Go and Python code paths must send this exact set (order matters — servers should preserve insertion order to match the profile's header order).

---

## 8. Library Reality Check

| Question | `bogdanfinn/tls-client` (Go) | `curl_cffi` (Python) |
|---|---|---|
| Runtime-selectable profile (no recompile)? | **Yes** — `WithClientProfile(profiles.Chrome_146)` at client construction. A config string maps to a profile value. | **Yes** — `impersonate="chrome146"` string kwarg per request/session. |
| Generic "latest" alias? | No named alias; select an explicit profile (or read newest from the profiles map). | **Yes** — `impersonate="chrome"` → newest shipped. (We pin explicitly for reproducibility, not the alias.) |
| Highest Chrome profile (as of research) | **Chrome_146 / Chrome_146_PSK** | **chrome146** |
| Bundles matching H2 + headers with profile? | Yes (forked net/http carries H2 fingerprint; headers documented per profile). | Yes (curl-impersonate bundles header block per target). |
| Latest release / maintenance | v1.15.1 (2026-06-08); active (~35 releases). | Release 2026-04-03; active; optional paid impersonate.pro tier. |

Both libraries are **config-driven at runtime**, so a file-driven identity is feasible with **zero recompilation** — a server reads the JSON on start and passes the string through. This is the load-bearing feasibility fact for the whole design. ([tls-client repo](https://github.com/bogdanfinn/tls-client), [tls-client client-options](https://bogdanfinn.gitbook.io/open-source-oasis/tls-client/client-options), [curl_cffi targets](https://curl-cffi.readthedocs.io/en/latest/impersonate/targets.html), [curl_cffi repo](https://github.com/lexiforest/curl_cffi))

---

## 9. Data Sources (with license + freshness notes)

| Source | Use | Offline? | Freshness | License |
|---|---|---|---|---|
| **Library-bundled headers** (curl-impersonate header blocks; tls-client profile docs) | Primary — the header set that *matches* the TLS profile. Prefer this; it is coherent by construction. | Yes (vendored with the lib) | Tracks the lib | MIT (both libs) |
| **Chrome for Developers — UA-CH** & **chromium.org/updates/ua-ch** | Authoritative algorithm for deriving `Sec-CH-UA`, platform tokens, frozen UA form. | Doc, cache locally | Stable spec | Google docs (reference, not redistributed) |
| **MDN `Sec-CH-UA*` pages** | Header semantics + example shapes. | Doc | Stable | CC-BY-SA (MDN) — reference only |
| **Chromium version history / `chromiumdash` build data** | The one thing algorithms can't invent: the **full build string** (`146.0.7258.67`) for `Sec-CH-UA-Full-Version-List`. Vendor a tiny `major → latest-build` table, refresh on library bump. | Vendored table | ~monthly; refreshed with lib | Public data |
| **`user-agents` npm / useragents.me / WhatIsMyBrowser** | *Evaluated, not recommended as primary.* Pools of real-world UAs. Risk: a pooled UA can mismatch the pinned TLS profile → violates the Central Principle. Licenses vary (useragents.me/WhatIsMyBrowser are API/attribution-gated; `user-agents` is MIT but scraped/stale). Use at most as a **cross-check** that our derived UA is plausible, never as the source. | npm: yes; others: API | Varies / can be stale | MIT / proprietary API |
| **Local browser itself** | Ground truth for *version* (§3). Not for header strings (a headless probe would add a heavy dependency). | Yes | Live | n/a |

**Best source for UA/client-hints: the fingerprint library's own bundled header block, keyed to the pinned profile.** It is offline, MIT-licensed, and — critically — *already coherent with the TLS/H2 layers of that exact profile*. Deriving `Sec-CH-UA` from `browser_major` via the documented Chromium algorithm fills any gaps, and a small vendored build-number table supplies the full-version-list. Third-party UA pools are explicitly demoted to an optional sanity cross-check because pooling reintroduces the drift this design exists to prevent.

---

## 10. Worked Example — This Machine (2026-07-04)

Live read-only detection on the operator's laptop:

```
macOS 26.3.1 (build 25D771280a), arm64
Google Chrome  150.0.7871.47      ← default browser
Safari         26.3.1
Microsoft Edge 149.0.4022.98
Firefox        152.0.4
Brave          146.1.88.138
```

Resolving Chrome **150** against the libraries (newest profile = **146** in both):

- No exact profile for 150 → nearest floor = **146**. `staleness_gap = 4` → **`degraded`**.
- Canonical claimed major = min(Go 146, Python 146) = **146**.
- `go_tls_client_profile = "Chrome_146"`, `curl_cffi_target = "chrome146"`.
- Derived UA claims **Chrome/146.0.0.0** (not 150) — because the TLS ClientHello it rides on is Chrome 146. Claiming 150 over a 146 ClientHello is exactly the incoherence we refuse.
- Emitted `warnings[]` tells the operator to run `refresh` once the libraries ship a Chrome ≥ 150 profile.

This is the design's normal steady state made concrete: the local browser is 4 majors ahead of the library, and the system deliberately pins to what it can *actually reproduce* while surfacing the gap. (The `identity` / `http` blocks in the §7.2 schema are this machine's real resolved values.)

---

## 11. Phased Plan + Acceptance Criteria

> **KISS gate (repeat):** do not start Phase 1 until the first MCP server that must beat active bot management is scheduled into the fleet. This plan is dormant until then.

**Phase 0 — Detection library (Go, in fleetd).**
Cross-platform detection (§3) + OS/arch. *Accept:* on macOS/Linux/Windows, `browser-identity detect` prints correct default browser, version, OS, arch. Unit-tested against fixture `Info.plist`/registry/`--version` outputs. Graceful "no browser found" path.

**Phase 1 — Identity generation + schema.**
Nearest-profile resolver (§4) with runtime-loaded per-library major tables; UA/hint derivation (§5); atomic write of `~/.mcp-fleet/browser-identity.json` (§7.2). *Accept:* `init` produces a schema-valid file; on this machine it yields `Chrome_146`/`chrome146`, `browser_major:146`, `staleness_gap:4`, and a UA claiming 146. Resolver unit tests cover exact / near / degraded / below-all / wrong-family fallback.

**Phase 2 — Consumer wiring (both runtimes).**
Go servers read the JSON → `WithClientProfile` + emit `http.headers`. Python servers read the JSON → `impersonate=` + emit `http.headers`. Wire the **thesun** generator so every browser-realistic server is generated to read the file. *Accept:* a generated Go server and a generated Python server, hitting a local echo endpoint, send **byte-identical** UA + client-hint + Accept headers, and their JA3/JA4 both resolve to Chrome 146.

**Phase 3 — Refresh + re-validation.**
Start-time re-detect with in-place regenerate on browser move; `refresh` command; fail-safe fallback to pinned file on detection failure. *Accept:* bumping the fixture browser version regenerates the identity on next start and logs the change; deleting the browser falls back to the pinned file without crashing; upgrading a library table and running `refresh` closes a previously-`degraded` gap.

**Phase 4 — Coherence self-test / CI gate.**
`browser-identity check` asserts all layers agree: UA-major == `Sec-CH-UA` major == `tls.profile_major`; platform token ↔ `sec-ch-ua-platform`; `is_mobile` ↔ `?0/?1`; Firefox/Safari identities carry **no** `Sec-CH-UA`; `staleness_gap ≤ ceiling`. Optionally verify live JA3/JA4 against a fingerprint-echo service (e.g. a self-hosted check) and assert it equals the claimed profile. *Accept:* CI fails on any cross-layer disagreement or on `gap > ceiling`; passes for a coherent 146 identity. Wire into thesun's Conformance Lab as an anti-fingerprint gate.

---

## 12. Browser-Automation Stealth (patchright) — the *other* layer

Everything above (§1–§11) is the **data plane**: after a session/token is acquired, the MCP servers make realistic HTTP requests (TLS/JA3, H2, UA, client hints). **patchright is a different layer entirely** — the **control plane / acquisition** step where Hermes drives a *real headless browser* through an interactive SSO login to obtain the session in the first place. Conflating the two is the mistake to avoid; they are complementary.

```
   ┌───────────────────────────────┐        ┌────────────────────────────────────┐
   │  ACQUISITION (control plane)  │  hands │  DATA PLANE (steady-state requests) │
   │  Hermes + patchright          │  token │  MCP servers + tls-client/curl_cffi │
   │  drives a headless browser    │ ─────► │  browser-identity.json (§1–§11)     │
   │  through the SSO login UI      │  →     │  realistic TLS/UA/H2 per request    │
   └───────────────────────────────┘        └────────────────────────────────────┘
     defeats: automation-detection            defeats: TLS/H2/UA fingerprinting
     (navigator.webdriver, CDP leaks)          (JA3/JA4, header order, UA-CH)
```

Hermes already centralizes the heavy browser-acquisition burden (memory: *thesun Hermes auth migration*), so **patchright belongs on the Hermes side only** — the MCP servers never launch a browser. This section is a recommendation for that layer; **do not modify Hermes as part of this work.**

### 12.1 Why vanilla Playwright gets flagged

Playwright automates Chromium over the **Chrome DevTools Protocol (CDP)**, and the act of automating leaks signals that bot managers (Cloudflare, DataDome, Kasada, PerimeterX) detect:

- **`Runtime.enable` (the headline leak).** Playwright calls the CDP `Runtime.enable` domain to get execution-context events. That call is observable from inside the page (it perturbs the JS runtime / lets a page correlate a side-channel), and it is **the single most reliable Playwright/Puppeteer tell in 2025–2026.** patchright's core patch is to *never* call `Runtime.enable` and instead execute JS in **isolated ExecutionContexts**.
- **`Console.enable` leak.** The Console CDP domain is similarly observable; patchright disables the Console API entirely (trade-off: `console` events don't surface).
- **`navigator.webdriver === true`.** Set when `--enable-automation` is present. patchright drops `--enable-automation` and adds `--disable-blink-features=AutomationControlled`.
- **Automation command-line flags.** patchright strips revealing defaults (e.g. `--disable-component-update`, `--no-sandbox` patterns) that differ from a real user's Chrome.
- **General codebase tells** — patched-out "obvious detection points" in stock Playwright setup.

Vanilla stealth plugins (e.g. `playwright-extra` + stealth) patch *JS-surface* properties but **do not fix the `Runtime.enable`/CDP-level leaks**, which is why they now fail against modern antibots and patchright (a source-level patch) succeeds.

### 12.2 Is it a true drop-in?

**Yes — a source-level patched fork with an identical API.**

| | Detail |
|---|---|
| Python package | **`patchright`** (PyPI) / repo `Kaliiiiiiiiii-Vinyzu/patchright-python`. `pip install patchright`, then `patchright install chromium`. |
| Node package | **`patchright`** (npm) / repo `Kaliiiiiiiiii-Vinyzu/patchright`. |
| API compatibility | Drop-in: change the import (`from patchright.sync_api import sync_playwright`) — same API surface. |
| License | **Apache-2.0** (permissive; fine for this workspace). |
| Maintenance | Active; **tested against upstream Playwright's own test suite after every release.** Tracks Playwright; a breaking upstream change may take a few days to re-patch. |
| Scope | **Chromium-based only.** Firefox and WebKit are *not* patched (they don't use CDP the same way). Fine — SSO logins run on Chrome. |

Since Hermes is Node-side today, the Node `patchright` package is the direct swap; if any acquisition helper is Python, `patchright` (Python) is the mirror. A [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) alternative exists (same `Runtime.enable` fix) but patchright is the more turnkey drop-in.

### 12.3 The efficiency angle (operator's question) — accurate, with a nuance

The operator's framing — *real-Chrome stealth parity without keeping a full heavy Chrome running constantly* — is **correct**, with one refinement:

- **Neither** vanilla Playwright nor patchright keeps a browser "running constantly." A login browser is launched **on demand, per acquisition, then torn down.** The steady-state MCP data plane (tls-client/curl_cffi) uses **no browser at all** — it's plain HTTP. So the always-on cost the operator wants to avoid simply isn't there in this architecture: heavyweight browser only during the brief interactive login, lightweight HTTP for everything after.
- **Bundled patched Chromium vs driving system Chrome:** patchright ships its **own patched Chromium** (`patchright install chromium`) so you don't need to manage a separate Chrome install — self-contained, disposable, headless-friendly. **However, patchright's own docs recommend `channel="chrome"` (system Google Chrome) + `launch_persistent_context` for *best* stealth** (a real Chrome build + a real user-data dir looks most human), and — notably — advise **not** setting a custom `user_agent`/headers in that mode (let real Chrome speak for itself).
- **Reconciling the two:** for a *thin, disposable, low-footprint* acquisition worker, the **bundled patched Chromium headless, launched per-login** is the lighter option and avoids a full always-installed Chrome — this matches the operator's efficiency goal. Use `channel="chrome"` only if a specific target defeats the bundled Chromium; it's the heavier, higher-stealth fallback. Either way it's transient, not resident.

Rough footprint: a patched-Chromium headless launch is a normal Chromium process (~a few hundred MB while the login runs) that exits immediately after token capture — versus a resident always-on Chrome you'd otherwise babysit. The win is **on-demand + self-contained**, not a smaller browser engine.

### 12.4 Layer division of labor (do not conflate)

| Concern | Layer | Tooling | Defeats |
|---|---|---|---|
| **Log in / acquire session** (interactive, per SSO) | Control plane — **Hermes** | **patchright** (patched Chromium, headless, on-demand) | Automation-detection: `Runtime.enable`/CDP leaks, `navigator.webdriver`, automation flags |
| **Make the actual API/data requests** (steady state, high volume) | Data plane — **MCP servers** | **tls-client (Go) / curl_cffi (Python) + `browser-identity.json`** (§1–§11) | Network fingerprinting: JA3/JA4 TLS, HTTP/2, UA + client-hints coherence |

They are **not substitutes.** patchright makes the *login browser* look human; the browser-identity config makes the *subsequent HTTP traffic* look human. A system that got one right and the other wrong is still caught. Because Hermes hands off only a token/cookie to thin MCP servers, the expensive browser stealth is paid **once per acquisition** and the cheap HTTP stealth covers the **millions of downstream requests** — the same thin-MCP economics Hermes already established.

---

## 13. Open Questions

1. **Hardest problem — build-number provenance for `Sec-CH-UA-Full-Version-List`.** Everything else derives from one integer; the full quad build string (`146.0.7258.67`) cannot be invented and drifts monthly. Options: (a) vendor a `major→build` table refreshed with each library bump (recommended — offline, small, versioned); (b) omit the full-version-list header when unknown (some sites request it via `Accept-CH` and its absence is itself weakly suspicious); (c) accept a slightly-stale build within the pinned major (low risk — the *major* is what cross-checks care about). Needs a decision before Phase 1 ships. **This is the one field where "coherent" and "current" genuinely trade off, and the whole staleness story hinges on how gracefully it degrades.**
2. **Cross-runtime major unification.** Pinning both runtimes to `min(go_major, python_major)` guarantees a single claimed version but can force one runtime *below* its own newest profile. Is that acceptable, or should identity be **per-runtime** and unification applied only when two runtimes share an origin? (Leaning: per-runtime identity, unify lazily.)
3. **macOS `Sec-CH-UA-Platform-Version` mapping.** Chromium translates macOS versions through its own scheme (and historically capped them). Need the exact current mapping for macOS 26 → what real Chrome 146 emits, else the platform-version hint is a subtle tell.
4. **Non-default but *task-relevant* browser.** If the operator's default is Firefox but an anti-bot target is best defeated with a Chrome fingerprint, does the operator override `identity.browser`, or does each server declare its required family and the generator produce a *set* of identities? (Leaning: server declares required family; generator emits per-family identities from the same detection.)
5. **GREASE brand rotation fidelity.** We emit a fixed well-formed GREASE brand per major. Worth reproducing Chromium's exact per-version GREASE algorithm, or is well-formed-shape enough? (Believed sufficient; revisit if a target rejects it.)
6. **Ceiling for `staleness_gap`.** Default 6 is a guess (~2 Chrome quarters). Tune once a real target's tolerance is observed.
7. **patchright acquisition-browser version coherence.** The login browser (patchright bundled Chromium, or `channel="chrome"`) has its *own* version, independent of the pinned data-plane profile. Should Hermes's acquisition Chromium be version-aligned with `browser-identity.json` (so the login and the subsequent requests claim the same Chrome major), or is a version mismatch between acquisition and data plane acceptable because they hit the origin at different times/IPs? (Leaning: align opportunistically, don't hard-couple — the token, not the browser version, is what carries forward.)
8. **patchright bundled-Chromium vs `channel="chrome"` per target.** Default to the lighter bundled patched Chromium (efficiency), escalate to system Chrome only when a target defeats it. Needs a per-target policy knob in Hermes once a real anti-bot login target exists.

---

## Sources

- [bogdanfinn/tls-client — repo](https://github.com/bogdanfinn/tls-client) · [releases](https://github.com/bogdanfinn/tls-client/releases) · [client options](https://bogdanfinn.gitbook.io/open-source-oasis/tls-client/client-options)
- [curl_cffi — impersonation targets](https://curl-cffi.readthedocs.io/en/latest/impersonate/targets.html) · [lexiforest/curl_cffi repo](https://github.com/lexiforest/curl_cffi) · [PyPI](https://pypi.org/project/curl-cffi/)
- [Chrome for Developers — User-Agent Client Hints](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints) · [chromium.org UA-CH](https://www.chromium.org/updates/ua-ch/)
- [MDN — Sec-CH-UA-Full-Version-List](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-CH-UA-Full-Version-List) · [MDN — Sec-CH-UA](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-CH-UA)
- patchright — [repo (Node)](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) · [repo (Python)](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python) · [PyPI](https://pypi.org/project/patchright/) · alternative: [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches)
</content>
</invoke>
