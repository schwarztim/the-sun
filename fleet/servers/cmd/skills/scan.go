package main

import (
	"regexp"
	"strings"
)

// Runtime secret scan. Every skill body is scanned immediately before it is
// returned, and a hit REFUSES the read. This is a runtime guard, not a
// build-time list: the allowlist in catalogue.go fixes which files may be read,
// this fixes what may leave the process. A skill that is edited to add a
// credential after this server started is refused on the next call, without a
// restart and without anyone remembering to update a list.
//
// It fails closed by construction: the only path that returns a body is the one
// where scanBody returns no hit.
//
// A hit is reported by RULE NAME and LINE NUMBER only. The matched text is
// never captured into a message, a log line, or a tool result: the whole point
// of the refusal is that the value must not travel, and a "helpfully" detailed
// error would leak exactly what was being protected.

// secretRule is one detector. Pattern matches a line; a rule with a value group
// (valueGroup > 0) additionally runs the captured value through isPlaceholder,
// which is what keeps documentation ABOUT credentials serveable while a real
// value is refused.
type secretRule struct {
	name       string
	pattern    *regexp.Regexp
	valueGroup int
}

var secretRules = []secretRule{
	// Key material, unambiguous, no placeholder exemption.
	{name: "pem_private_key", pattern: regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)},
	{name: "ssh_private_key_body", pattern: regexp.MustCompile(`\bb3BlbnNzaC1rZXktdjE`)},

	// Vendor-shaped tokens. The shape itself is the evidence, so these are
	// matched whole and never exempted.
	{name: "aws_access_key_id", pattern: regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`)},
	{name: "github_token", pattern: regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{30,}\b`)},
	{name: "slack_token", pattern: regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{12,}\b`)},
	{name: "google_api_key", pattern: regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}\b`)},
	{name: "jwt", pattern: regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{10,}`)},
	{name: "azure_storage_key", pattern: regexp.MustCompile(`(?i)AccountKey=[A-Za-z0-9+/]{40,}={0,2}`)},

	// A credential embedded in a URL or connection string, e.g. scheme://user:pw@host.
	{name: "url_embedded_credential", pattern: regexp.MustCompile(`\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s/:@"']+:([^\s/@"']{4,})@`), valueGroup: 1},

	// An inline password handed to a command. Only the long, unambiguous flag
	// forms are matched: a bare `-p` is the same two characters as `mkdir -p`
	// and `grep -p`, so including it turned every runbook in the corpus into a
	// false positive.
	{name: "inline_password_flag", pattern: regexp.MustCompile(`(?i)(?:sshpass\s+-p\s*|--password[= ]\s*|--passwd[= ]\s*|--pass[= ]\s*)["']?([^\s"'|;&]{4,})`), valueGroup: 1},

	// An assignment whose left-hand side names a credential. This is the rule
	// that carries the placeholder exemption: prose and examples that discuss
	// secrets stay serveable, an assigned literal does not.
	//
	// The keyword is prefixed with [a-z0-9_.-]* rather than a word boundary
	// because an underscore is a word character, so \bpassword\b never matches
	// inside DB_PASSWORD or SERVICE_PASSWORD, which is the single most common
	// way a runbook writes one down.
	{
		name:       "assigned_credential",
		pattern:    regexp.MustCompile(`(?i)[a-z0-9_.-]*(?:passwd|password|passphrase|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|bearer[_-]?token|[a-z0-9]*_?token|secret)\b\s*[:=]+\s*["'` + "`" + `]?([^\s"'` + "`" + `,)\]}]{6,})`),
		valueGroup: 1,
	},

	// The prose form: "the password is hunter2". No assignment operator, so the
	// rule above misses it, and it is exactly how a hand-written runbook records
	// a credential.
	{
		name:       "prose_credential",
		pattern:    regexp.MustCompile(`(?i)\b(?:password|passphrase|passwd|api key|access key)\s+(?:is|are|=)\s+["'` + "`" + `]?([^\s"'` + "`" + `,.)]{4,})`),
		valueGroup: 1,
	},
}

// placeholderExact is the set of captured values that are self-evidently not
// secrets: type names, prompts, and the words a template uses in place of a
// value.
var placeholderExact = map[string]bool{
	"true": true, "false": true, "null": true, "nil": true, "none": true, "no": true, "yes": true,
	"string": true, "str": true, "int": true, "bool": true, "boolean": true, "object": true, "array": true,
	"required": true, "optional": true, "value": true, "values": true, "here": true, "above": true,
	"password": true, "passwd": true, "passphrase": true, "secret": true, "token": true, "apikey": true,
	"api_key": true, "api-key": true, "credential": true, "credentials": true, "redacted": true,
	"changeme": true, "changeit": true, "placeholder": true, "example": true, "sample": true,
	"dummy": true, "fake": true, "test": true, "unset": true, "empty": true, "hidden": true,
	"never": true, "always": true, "prompt": true, "input": true, "stored": true, "resolved": true,
	// Protocol constants that appear after a credential-shaped key but are
	// literals, not credentials. "nocheck" is Atlassian's documented value for
	// the X-Atlassian-Token CSRF header; "bearer" and "basic" are scheme names.
	"nocheck": true, "no-check": true, "bearer": true, "basic": true, "digest": true, "negotiate": true,
}

// placeholderPrefix covers the reference forms a runbook uses instead of a
// literal: shell/template interpolation, angle-bracket prompts, and the URI
// schemes this workspace resolves credentials through (Hermes, the vault, 1Password).
var placeholderPrefix = []string{
	"$", "<", "{", "%", "(", "[", "&", "*", "-", ".", "/", "\\", "!", "?", "…",
	"hermes://", "hermescred://", "op://", "keychain://", "env://", "vault://",
	"your", "my-", "the-", "xxx", "abc123", "yyy", "zzz", "insert", "paste", "enter",
}

// placeholderSubstring catches an interpolation or redaction anywhere in the
// value rather than only at its start, e.g. "Bearer-${TOKEN}" or "sk-****".
var placeholderSubstring = []string{
	"${", "$(", "{{", "<%", "***", "...", "xxxx", "____", "____", "redact", "your_", "your-",
	"_here", "-here", "example.com", "secrets.py", "hermes", "keyring", "keychain",
}

// envRefPattern matches a bare environment-variable reference used as the
// value, e.g. `token: GITHUB_TOKEN` or `password = $DB_PASSWORD`. Naming the
// variable that holds a secret is not disclosing the secret.
var envRefPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{2,}$`)

// slugPattern matches a kebab-case identifier: all lower case, no digits, at
// least one hyphen, e.g. `secretKey: "teams-alert-webhook"`. That is the name
// of a stored credential, not the credential, and it is how this workspace
// refers to vault entries throughout its documentation. A real secret carries
// digits, mixed case, or both; requiring one of those here is what keeps the
// scan from firing on every runbook that names the key it looks up.
var slugPattern = regexp.MustCompile(`^[a-z]+(?:-[a-z]+)+$`)

// isPlaceholder reports whether a captured value is documentation rather than a
// credential. It is deliberately generous: a false "this is a placeholder" only
// costs a missed detection on a file that is already on the allowlist, while a
// false "this is a secret" silently breaks a legitimate skill and teaches the
// operator to distrust the gate.
func isPlaceholder(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return true
	}
	lower := strings.ToLower(v)
	if placeholderExact[lower] {
		return true
	}
	for _, p := range placeholderPrefix {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	for _, s := range placeholderSubstring {
		if strings.Contains(lower, s) {
			return true
		}
	}
	if envRefPattern.MatchString(v) || slugPattern.MatchString(v) {
		return true
	}
	// A value made of one repeated character is a mask, not a credential.
	if len(v) > 2 {
		uniform := true
		for i := 1; i < len(v); i++ {
			if v[i] != v[0] {
				uniform = false
				break
			}
		}
		if uniform {
			return true
		}
	}
	return false
}

// scanHit names a refusal. It carries no matched text, by design.
type scanHit struct {
	Rule string
	Line int
}

// scanBody scans a skill body and returns the first hit, if any. Only the rule
// name and the 1-indexed line number are returned; the matched value is never
// captured out of this function.
func scanBody(body string) (scanHit, bool) {
	for i, line := range strings.Split(body, "\n") {
		for _, rule := range secretRules {
			m := rule.pattern.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			if rule.valueGroup > 0 && rule.valueGroup < len(m) && isPlaceholder(m[rule.valueGroup]) {
				continue
			}
			return scanHit{Rule: rule.name, Line: i + 1}, true
		}
	}
	return scanHit{}, false
}
