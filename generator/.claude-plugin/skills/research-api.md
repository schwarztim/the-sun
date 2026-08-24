---
name: research-api
description: Research and discover all APIs for a tool without generating code
---

# Research API Skill

Research and catalog all APIs for a tool. Use this for exploration and planning before committing to full MCP generation.

## When to Use

- "What APIs does {tool} have?"
- "Research {tool} before we build an MCP"
- "Find all the endpoints for {tool}"
- "Is there already an MCP for {tool}?"

## Invocation

Spawn the api-researcher agent:

```
<Task subagent_type="api-researcher">
Research all APIs for {tool}.

Find:
1. Official API documentation
2. OpenAPI/Swagger specifications
3. Authentication requirements
4. All endpoints with full details
5. Existing MCP implementations
6. Gaps in existing implementations

Create a comprehensive discovery-report.md
</Task>
```

## Output

The agent produces `discovery-report.md` containing:

- Total endpoint count
- Authentication methods
- Rate limits
- Complete endpoint reference
- Existing MCP analysis
- Gap identification
- Implementation recommendations

## Use Cases

### Planning
Research first, then decide if MCP generation is needed.

### Gap Analysis
Find what's missing in existing implementations.

### Documentation
Create API reference documentation.

### Comparison
Compare multiple tools' APIs before choosing.
