---
name: build-status
description: Check status of active MCP builds and view system health dashboard
---

# Build Status Skill

Check the status of MCP builds and system health.

## When to Use

- "What's the status of my build?"
- "Is the MCP generation done?"
- "How much has it cost so far?"
- "Are there any issues?"

## How to Check Status

### Quick Status Check

```bash
# Check log for recent activity
tail -50 ~/Scripts/thesun/logs/thesun.log

# List active build workspaces
ls -la /tmp/thesun/builds/
```

### Detailed Build Status

For a specific build, check:

```bash
# Build workspace contents
ls -la /tmp/thesun/builds/{tool}-{id}/

# Generated code
find /tmp/thesun/builds/{tool}-{id}/ -name "*.ts" | head -20

# Test results
cat /tmp/thesun/builds/{tool}-{id}/test-results.json

# Discovery report
cat /tmp/thesun/builds/{tool}-{id}/discovery-report.md
```

## Status Indicators

### Build Phases
- `pending` - Queued, not started
- `discovering` - Researching APIs
- `generating` - Creating code
- `testing` - Running tests (may iterate)
- `security_scan` - Security checks
- `optimizing` - Performance tuning
- `validating` - Final validation
- `completed` - Done successfully
- `failed` - Build failed

### Health Status
- `healthy` - All systems normal
- `degraded` - Some warnings, still running
- `critical` - Major issues, may pause builds

## Intervention Options

If a build is stuck:

```bash
# View detailed logs
grep -A 10 "ERROR\|WARN" ~/Scripts/thesun/logs/thesun.log

# Kill stuck process (last resort)
pkill -f "thesun"
```

## Cost Tracking

Builds track estimated cost based on:
- Model used (Opus: $15/MTok, Sonnet: $3/MTok, Haiku: $1/MTok)
- Total tokens consumed

Default limits:
- $50/job maximum
- $200/hour across all jobs
