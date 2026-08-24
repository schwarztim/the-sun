# Hermes GitHub Mirror

This is the GitHub mirror for Hermes:

`https://github.com/schwarztim/hermes.git`

Use `main` as the canonical branch. The repository should mirror the same
committed tree as Stash when Stash permissions allow pushes.

## Purpose

Hermes is a host-local, headless auth control plane for REST API MCPs that need
corporate SSO and Conditional Access. It standardizes credential acquisition,
downstream auth-failure feedback, coalesced recovery, propagation proof, and
operator remediation so generated MCPs can use one auth contract.

## AI agent context

- Copilot instructions live in `.github/copilot-instructions.md`.
- Claude context lives in `CLAUDE.md` and `.claude/context.md`.
- The core rule is headless-only auth: never introduce foreground browser auth or
  credential deletion as a first-line recovery path.

## Validation before publishing

For auth/reliability changes, run:

```bash
pnpm test
pnpm run build
pnpm -r typecheck
pnpm eval:reliability
pnpm smoke:live
```

`pnpm smoke:live` may surface degraded local credential state. Treat that as
operational if the broker is healthy, MCP tools are exposed, and Hermes returns a
safe `hermes acquire <service>` remediation.
