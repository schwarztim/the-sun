# Gateway config reference

The gateway reads a single YAML file (path from `MCP_GATEWAY_CONFIG`, e.g. `gateway/config.yaml`
or `config.fleet.yaml`). This page documents the policy knobs an operator edits: the `[gateway]`
search/bind settings, the `safety.escalation` tier policy, and the `content_guard` filters.
Every key below is verified against `gateway/src/config.ts`; unset keys take the defaults shown.

Backends are normally auto-ingested from the fleet, so most installs edit only the `gateway`,
`safety`, and `content_guard` sections. After editing, apply with `thesun gateway reload`.

## The two things most operators come here to do

- **Name a production backend** so every non-read tool on it requires human approval: add its
  namespace to `safety.escalation.production_backends`.
- **Un-flag a tool the escalation overlay mis-classified** (for example a read-only tool whose
  name contains "purge"): add `"<backend>.<tool>"` to `safety.escalation.exempt`.

## `gateway` — routing, search, bind safety

```yaml
gateway:
  port: 3100                       # loopback port the mux listens on
  host: 127.0.0.1                  # bind address (loopback by default)
  log_level: info                  # debug | info | warn | error
  search_semantic: true            # semantic ranking for gateway_search_tools
  search_top_k: 8                  # default number of tools search returns
  allow_insecure_non_loopback: false
```

- `search_semantic` (default `true`): `gateway_search_tools` ranks backend tools by semantic
  similarity using a local, in-process embedding model, so a query surfaces relevant tools even
  without a literal name match. If the optional model dependency is missing or fails to load,
  search transparently degrades to keyword (token-set) ranking. Set `false` to always use
  keyword ranking.
- `search_top_k` (default `8`): how many tools `gateway_search_tools` returns when the caller
  passes no explicit limit. Keeps the client context small.
- `allow_insecure_non_loopback` (default `false`): an escape hatch that DISABLES the fail-closed
  bind guard which refuses to start when the gateway binds a non-loopback host with `auth.mode:
  none` and no `shared_secret` (an unauthenticated tool plane reachable off-box). Set `true`
  ONLY when the non-loopback interface sits on a segment you have secured by other means; it does
  not add auth, it only silences the safety check. Loopback binds are unaffected either way.

## `safety.escalation` — Tier-A → Tier-B overlay

Manifests declare facts (safety class, HTTP method, tool name); this overlay escalates
genuinely dangerous Tier-A tools up to Tier-B, so the out-of-band human approval (the only
control that holds against a full-auto, hook-less client) actually covers them. It is monotonic:
Tier-A → Tier-B only, never touches a READ or an already-Tier-B classification.

```yaml
safety:
  escalation:
    enabled: true                  # set false to revert to manifest-only Tier-B
    delete_method_to_tier_b: true  # any tool whose http_method is DELETE → Tier-B
    destructive_verbs:             # tool-name verbs that escalate to Tier-B
      - delete
      - remove
      - purge
      - destroy
      - drop
      - terminate
      - kill
      - revoke
      - wipe
      - erase
      - shutdown
      - deprovision
      - force
    outbound_verbs:                # verbs that escalate to HUMAN_OUTBOUND (Tier-B + PCI/SSN arg block)
      - send
      - reply
      - email
      - notify
      - broadcast
      - publish
      - comment
      - message
    production_backends: []        # backend-name globs whose non-READ tools escalate to PRODUCTION
    exempt: []                     # "backend.tool" entries you declare misclassified — skip escalation
```

- `enabled` (default `true`): master switch. `false` reverts to pre-overlay behavior (Tier-B
  only via hand-authored manifests).
- `delete_method_to_tier_b` (default `true`): escalate any tool whose HTTP method is DELETE.
- `destructive_verbs` / `outbound_verbs` (defaults above): trim to tune sensitivity. Outbound
  verbs additionally arm the Luhn/SSN argument block on those calls.
- `production_backends` (default `[]`, empty): opt-in. Add a backend namespace glob to force
  every non-read tool on it through Tier-B approval.
- `exempt` (default `[]`, empty): `"<backend>.<tool>"` entries the operator declares
  misclassified; the overlay skips escalation for exactly those.

Related `safety` keys: `enforce` (`blocking` default, or `advisory`), `notifications` (default
`true`, best-effort OS toast when a Tier-B call parks), `confirm_token` (default `true`, HMAC
audit integrity on Tier-A confirms), and `escalation` aside, the fail-closed
`unmanifested_read_allowlist` (default `[]`).

## `content_guard` — egress redaction and argument blocking

Scans tool arguments and results for secrets and sensitive data. Result scanning redacts;
argument scanning on HUMAN_OUTBOUND (Tier-B outbound) calls blocks.

```yaml
content_guard:
  secrets: { enabled: true }          # redact AWS/GitHub/OpenAI/Slack/Google/bearer/private-key in results
  luhn: { enabled: true }             # Luhn-valid card: BLOCK on outbound args, redact in results
  ssn: { enabled: false }             # US SSN: BLOCK on outbound args, redact in results (opt-in)
  sql_destructive: { enabled: false } # destructive-SQL arg block, scoped to sql/exec tools (opt-in)
  entropy: { enabled: false }         # high-entropy blob redaction in results (opt-in; false-positive-prone)
  max_scan_chars: 1000000             # per-string scan budget; the oversize remainder is WITHHELD, not passed
```

- `secrets` (default `on`) and `luhn` (default `on`) are the always-on baseline.
- `ssn`, `sql_destructive`, and `entropy` default `off`: opt-in. `entropy` is deliberately off
  because it is false-positive-prone (hashes, signatures, and other random-looking values get
  redacted too).
- `max_scan_chars` (default `1000000`) is a **per-string scan budget, not a pass-through**. It
  bounds regex cost per string leaf; it does not let oversized content escape. A string longer
  than the cap has its head window scanned and redacted, and the remainder withheld behind a
  `[REDACTED:oversize-withheld]` marker. On the outbound-argument path an oversized argument
  blocks the call outright, even when the scanned head is clean. Raising the cap therefore
  trades CPU for how much of a large payload survives intact; lowering it truncates more
  results but never widens what can leak. (Earlier revisions of this doc described these
  payloads as passing through unscanned, which was the pre-SEC-3/SEC-9 behavior.)

## Per-backend tool visibility and client-facing overrides

Two independent knobs for controlling what a client sees. Both are cosmetic-or-narrowing
only: neither grants access, and neither is a security control (the safety tiers are).

Visibility is **per backend**, alongside that backend's other settings:

```yaml
backends:
  - namespace: jira
    transport: http
    url: http://127.0.0.1:42031/mcp
    tools_allow: ["jira_search", "jira_get_issue"]   # if set, ONLY these are exposed
    tools_deny:  ["jira_delete_issue"]               # always wins over tools_allow
```

`tools_deny` beats `tools_allow`. The filter is applied at every backend-registration site, so
a hidden tool never reaches `tools/list`, and it fails closed: a hidden tool that is called
anyway is refused. Use this to shrink a noisy backend's surface; do not use it as the reason a
dangerous tool is safe.

Renames and description rewrites are **gateway-level**, under `gateway:`:

```yaml
gateway:
  tool_overrides:
    az_teams_send_message:                    # key = the ORIGINAL namespaced tool name
      name: teams_send                        # optional: the name clients see
      description: "Send a Teams message."    # optional: shorten to cut per-tool tokens
```

Only the client-facing surface changes. Dispatch still routes on the original name, so a
rename never breaks call routing, and a rename that collides with an already-exposed name is
ignored (the original is kept and a warning is logged) so a tool is never silently dropped.

## See also

- [`SECURITY-MODEL.md`](SECURITY-MODEL.md) — the two-tier threat model these knobs implement.
- [`SECURITY-ROADMAP.md`](SECURITY-ROADMAP.md) — design rationale for the escalation overlay.
