# First-time Setup

Prerequisites:
- Node.js 20+
- pnpm 9+
- On Linux only: libsecret (for keytar): `apt install libsecret-1-dev gnome-keyring`

## 1. Install

```bash
cd ~/Projects/hermes
pnpm install
pnpm -r build
```

## 2. Initialize data directory

```bash
node packages/broker/dist/cli.js init
```

Creates `~/.hermes/config.json` and `~/.hermes/client.token`.

## 3. Register ms365

```bash
node packages/broker/dist/cli.js register ms365 \
  --provider ms365 \
  --scheme graph teams outlook \
  --config '{"loginHint":"your-email@example.com","tenant":"common"}'
```

## 4. Acquire initial tokens headlessly

```bash
node packages/broker/dist/cli.js acquire ms365
```

Hermes runs the provider's headless authentication flow and stores resulting
credentials in the system keyring. It must not open a foreground browser. If
corporate Conditional Access blocks the headless flow, Hermes returns a
structured remediation command and challenge classification; complete that
operator action and retry the acquire command.

## 5. Add Hermes to your MCP client config

Add to `~/.claude/user-mcps.json`:

```json
{
  "hermes": {
    "command": "node",
    "args": ["/absolute/path/to/hermes/packages/broker/dist/cli.js", "start", "--stdio"]
  }
}
```

## 6. Point container MCPs at Hermes

For each containerized MCP that needs tokens:

```
HERMES_URL=http://host.docker.internal:9876
HERMES_CLIENT_TOKEN=<contents of ~/.hermes/client.token>
```

Store HERMES_CLIENT_TOKEN via `thv secret set`. Do not commit it.

## Troubleshooting

- **"broker unreachable"**: use `hermes doctor`; if port `9876` is owned by an
  orphaned broker, follow the README recovery procedure and restart launchd.
- **"ACQUIRE_REQUIRED"**: run the exact `hermes acquire <service>` command Hermes
  returns; do not delete credentials.
- **Browser profile lock**: retry after Hermes' cooldown or run the surfaced
  remediation. Do not bypass headless mode.
- **"Conditional Access blocked"**: host device, VPN, CA policy, TOTP, consent,
  or device-certificate state needs operator action; Hermes should classify and
  report it rather than opening UI.
