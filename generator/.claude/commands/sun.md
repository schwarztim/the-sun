---
name: sun
description: Generate MCP servers autonomously
arguments:
  - name: tool
    description: Name of the tool/API to generate MCP for (e.g., dynatrace, servicenow, slack)
    required: true
  - name: output
    description: Output directory for generated MCP server
    required: false
  - name: spec
    description: Path or URL to OpenAPI/Swagger specification
    required: false
---

# /sun Command

Generate a production-ready MCP server autonomously.

## What This Does

When you run `/sun <tool>`, the system:

1. **Researches the API** - Finds documentation, existing MCPs, OpenAPI specs
2. **Generates complete MCP server** - TypeScript, tests, documentation
3. **Runs tests and iterates** - Fixes failures automatically
4. **Security scans** - Blocks on critical issues
5. **Optimizes performance** - Caching, pooling, etc.
6. **Delivers ready-to-use code** - In the specified output directory

## Usage Examples

```
/sun dynatrace
/sun servicenow --output=./servicenow-mcp
/sun slack --spec=https://api.slack.com/specs/openapi/v2/slack_web.json
```

## What You Need to Provide

- **Tool name**: The API/service you want to generate an MCP for
- **Authentication**: You'll be prompted for credentials when needed

## What You DON'T Need to Do

- Research the API (done automatically)
- Write any code (generated automatically)
- Fix test failures (iterated automatically)
- Optimize performance (done automatically)

## Execution

### Step 1: Strategic Analysis (Opus)

First, launch the `meta-planner` agent to analyze the request and adapt the approach:

```
<Task subagent_type="meta-planner" model="opus">
Analyze this MCP generation request:
- Tool: {tool}
- Output: {output or default}
- Spec: {spec if provided}

Assess complexity, anticipate problems, and design the optimal approach.
Return a build strategy with any adjustments to the standard workflow.
</Task>
```

### Step 2: Execute Build (Sonnet)

Once the meta-planner confirms the approach, launch `mcp-builder`:

```
<Task subagent_type="mcp-builder">
Generate MCP server for {tool} following the strategy from meta-planner.
{Include any special instructions from meta-planner}
</Task>
```

### Progress Monitoring

You can check progress at any time with `/sun-status`.

The meta-planner may intervene during the build if:
- Unexpected patterns emerge
- Build hits repeated failures
- Scope changes significantly
- Security concerns arise

---

**IMPORTANT**: The meta-planner uses Opus for strategic decisions. The mcp-builder uses Sonnet for implementation efficiency. This optimizes both quality (strategic thinking) and cost (bulk work).
