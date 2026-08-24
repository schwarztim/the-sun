---
name: fix-mcp
description: Fix and improve an existing MCP server using thesun FIX mode
---

# Fix MCP Skill

Fix, repair, or improve an existing MCP server. Uses thesun's FIX mode to autonomously identify and resolve issues.

## When to Use

- "Fix the {tool} MCP"
- "The {tool} MCP has build errors"
- "Improve the {tool} MCP"
- "Update the {tool} MCP to fix issues"
- "Run thesun on {path/to/mcp}"

## How It Works

FIX mode:
1. **Validates** the existing MCP (score 0-100)
2. **Identifies** missing items and issues
3. **Fixes** problems autonomously
4. **Iterates** until all requirements met (up to 3 attempts)

## Invocation

Use the thesun MCP tool with `fix` parameter:

```
thesun({ target: "{tool}", fix: "{path/to/mcp}" })
```

### Examples

```
# Fix a specific MCP by path
thesun({ target: "elastic", fix: "/Users/user/Scripts/elastic-mcp" })

# Fix an MCP in the default location
thesun({ target: "crowdstrike", fix: "~/Scripts/mcp-servers/crowdstrike-mcp" })

# Self-improvement - fix thesun itself!
thesun({ target: "thesun", fix: "/Users/user/Scripts/thesun" })
```

## What Gets Validated

| Check | Description |
|-------|-------------|
| package.json | Valid npm package with required fields |
| Entry point | src/index.ts exists and exports correctly |
| Build | `npm run build` passes without errors |
| Tests | `npm test` passes (if tests exist) |
| README.md | Documentation exists |
| .env.example | Configuration template exists |
| Architecture docs | CLAUDE.md or similar exists |
| Git repository | Initialized with remote |
| Graceful startup | Starts without credentials |

## Output

Returns:
- **Score**: 0-100 validation score
- **Issues found**: List of problems identified
- **Fixes applied**: What was changed
- **Remaining issues**: Any unresolved problems

## Use Cases

### Build Failures
Fix TypeScript errors, dependency issues, or configuration problems.

### Test Failures
Diagnose and fix failing tests.

### Missing Components
Add missing files like README, .env.example, or documentation.

### Self-Improvement
Use `thesun({ target: "thesun", fix: "." })` to improve thesun itself!

## Tips

- Always provide the correct path to the MCP root directory
- FIX mode iterates up to 3 times before giving up
- For minor issues, a single iteration usually suffices
- For complex issues, may require multiple fix cycles
