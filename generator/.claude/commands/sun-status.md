---
name: sun-status
description: View thesun build status and system health
---

# /sun-status Command

View the status of active MCP builds and overall system health.

## What This Shows

1. **Active Builds**
   - Tool name
   - Current phase
   - Duration
   - Iteration count
   - Estimated cost

2. **System Health**
   - Overall status (healthy/degraded/critical)
   - API call rate
   - Cost tracking
   - Any warnings or issues

3. **Recent Completions**
   - Last 5 completed builds
   - Success/failure status
   - Final metrics

## Usage

```
/sun-status
```

## Checking Progress

To check on a specific build:

```bash
# Read the build log
cat ~/Scripts/thesun/logs/thesun.log | grep "<build-id>"

# Check the workspace
ls -la /tmp/thesun/builds/<tool-name>-<id>/
```

## Interventions

If a build is stuck or runaway:

```
# Pause all builds
npm run --prefix ~/Scripts/thesun orchestrator:pause

# Terminate specific build
npm run --prefix ~/Scripts/thesun orchestrator:terminate -- --job=<id>
```
