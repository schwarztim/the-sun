# atlassian-mcp

thesun-generated Go MCP server (transport: **streamable-HTTP only** — never stdio/SSE).

## Tools

- `atlassian_search_jira_issues` — POST /rest/api/3/search/jql
- `atlassian_get_issue` — GET /rest/api/3/issue/{issueKey}
- `atlassian_create_issue` — POST /rest/api/3/issue
- `atlassian_update_issue` — PUT /rest/api/3/issue/{issueKey}
- `atlassian_add_jira_comment` — POST /rest/api/3/issue/{issueKey}/comment
- `atlassian_get_transitions` — GET /rest/api/3/issue/{issueKey}/transitions
- `atlassian_transition_issue` — POST /rest/api/3/issue/{issueKey}/transitions
- `atlassian_get_projects` — GET /rest/api/3/project/search
- `atlassian_get_project` — GET /rest/api/3/project/{projectKey}
- `atlassian_get_current_user` — GET /rest/api/3/myself
- `atlassian_get_my_issues` — POST /rest/api/3/search/jql
- `atlassian_get_in_progress_issues` — POST /rest/api/3/search/jql
- `atlassian_get_recent_issues` — POST /rest/api/3/search/jql
- `atlassian_assign_issue` — PUT /rest/api/3/issue/{issueKey}/assignee
- `atlassian_search_users` — GET /rest/api/3/user/search
- `atlassian_search_confluence` — GET /wiki/rest/api/content/search
- `atlassian_get_confluence_page` — GET /wiki/rest/api/content/{pageId}
- `atlassian_get_confluence_page_by_title` — GET /wiki/rest/api/content
- `atlassian_create_confluence_page` — POST /wiki/rest/api/content
- `atlassian_update_confluence_page` — PUT /wiki/rest/api/content/{pageId}
- `atlassian_get_confluence_spaces` — GET /wiki/rest/api/space
- `atlassian_get_confluence_space` — GET /wiki/rest/api/space/{spaceKey}
- `atlassian_add_confluence_comment` — POST /wiki/rest/api/content
- `atlassian_search_confluence_by_text` — GET /wiki/rest/api/content/search
- `atlassian_get_confluence_page_v2` — GET /wiki/api/v2/pages/{pageId}

## Run locally

```bash
go build -o atlassian-mcp .
MCP_HOST=127.0.0.1 MCP_PORT=42015 ./atlassian-mcp
# MCP endpoint: POST http://127.0.0.1:42015/mcp   (health: GET /healthz)
```

MCP_PORT is required and has no default.

## Container

```bash
docker build -t atlassian-mcp .
docker run --rm -e MCP_PORT=42015 -p 42015:42015 atlassian-mcp
```

## Configuration & credential onboarding

**Your Atlassian site (required).** Every Atlassian Cloud site has its own
subdomain, so there is no usable default:

```bash
export ATLASSIAN_BASE_URL=https://your-domain.atlassian.net
```

Every tool call is refused with a clear error until this is set.

This server resolves its credential in **dual mode** (identical to thesun's Python
output), preferring the Hermes broker and falling back to environment variables.
The value is never logged or surfaced in tool output.

**Easy onboarding (recommended — Hermes broker).** Enroll the secret in Hermes
once — the value is read from a hidden prompt/stdin and never appears in your
shell history:

```bash
hermes creds set atlassian basic
export HERMES_URL=http://127.0.0.1:9876
export HERMES_CLIENT_TOKEN=$(cat ~/.hermes/client.token)
```

When `HERMES_URL` + `HERMES_CLIENT_TOKEN` are set the server fetches the
credential from `GET {HERMES_URL}/token/atlassian/basic`.

**Fallback (standalone).** Set `ATLASSIAN_API_KEY` (or `_TOKEN`) in
the environment — see `.env.example`.

**Under fleetd.** Put a `hermes://` ref in `fleet.toml`; fleetd resolves it and
injects the credential into this process's env at spawn — no broker vars needed
in the unit.
