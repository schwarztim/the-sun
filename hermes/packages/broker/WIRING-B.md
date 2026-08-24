# Workstream B — cli.ts wiring instructions (Phase 3, PM-applied)

Everything below targets **`packages/broker/src/cli.ts`** `start` command only.
All referenced modules are already built and tested; this file is the ONLY
remaining integration step. Line numbers refer to the cli.ts as of 2026-06-11
(pre-sibling-merge); anchor on the quoted code, not the numbers, if the
browser-registry sibling has already landed.

## 0. Imports (top of cli.ts)

Add to the existing import block:

```ts
import { ConnectivityGate } from './connectivity.js';
import { scheduleStoredTokenRefreshes, scheduleTokenRefresh, scheduleFailureRetry, clearFailureBackoff, resetAllFailureBackoff } from './lifecycle.js';
```

(`scheduleStoredTokenRefreshes`, `scheduleTokenRefresh`, `scheduleFailureRetry`,
`clearFailureBackoff` are already imported on line 17 — just add
`resetAllFailureBackoff` to that list and add the `ConnectivityGate` import.)

## 1. Construct the gate (after `loadConfig`, before the scheduler — ~line 94)

Insert right after `const validator = new TokenValidator(...)` (line 94) and
**replace** that line so the validator gets the validation gate (note: `broker`
is declared `let` later; the closure is invoked lazily so this is safe):

```ts
const connectivity = new ConnectivityGate({ logger, config: config.connectivity });
connectivity.start();
const validator = new TokenValidator({
  policy: config.validationPolicy,
  safetyMarginSec: config.refreshSafetyMarginSec,
  validationGate: (service, scheme) => broker.validationGate(service, scheme),
});
```

## 2. Scheduler refresh callback — skip + cheap re-arm while offline (~line 105-111)

Replace the `RefreshScheduler` construction:

```ts
const scheduler = new RefreshScheduler({
  logger,
  refresh: async (service, scheme) => {
    if (!await connectivity.isOnline()) {
      logger.info('offline: skipping scheduled refresh', { service, scheme });
      scheduleFailureRetry(scheduler, service, scheme,
        new Error('offline'), logger,
        { connectivity, offlineRearmMs: config.connectivity.offlineRecheckMs * 2 });
      return;
    }
    await broker.getToken(service, scheme, { refresh: true });
  },
  onRefreshFailed: (service, scheme, error) => {
    scheduleFailureRetry(scheduler, service, scheme, error, logger,
      { connectivity, offlineRearmMs: config.connectivity.offlineRecheckMs * 2 });
  },
});
```

Also update the standalone `onRefreshFailed` const (~line 128-130) to pass the
same options object, and pass `{ connectivity, offlineRearmMs: ... }` — it is
handed to `new Broker(...)` as `onRefreshFailed`.

## 3. Broker deps (~line 131)

Replace the `broker = new Broker({...})` call:

```ts
broker = new Broker({
  storage, registry, validator, logger, dataDir: config.dataDir, lifecycleStore,
  onTokenRefreshed, onRefreshFailed, onOperatorActionRequired,
  connectivity,
  adBudget: config.adBudget,
  offlineOptions: {
    serveCachedWhileOffline: config.connectivity.serveCachedWhileOffline,
    retryAfterMs: config.connectivity.offlineRecheckMs,
    safetyMarginMs: config.refreshSafetyMarginSec * 1000,
  },
});
await broker.init();   // hydrate persisted governor state BEFORE serving anything
```

`broker.init()` must run before `scheduleStoredTokenRefreshes` (line 132) and
before `http.listen`.

## 4. Health monitor gating (~lines 135-149, `onWarning`)

Insert at the top of the `onWarning` callback, before the
`void broker.getToken(..., { force: true })` line:

```ts
if (connectivity.getState() !== 'online') {
  logger.info('offline: skipping proactive reacquire from health warning', { service: health.service, scheme: health.scheme });
  return;
}
const gateCheck = broker.canAttemptAcquire(health.service, health.scheme);
if (!gateCheck.ok) {
  logger.info('proactive reacquire suppressed by acquire gate', { service: health.service, scheme: health.scheme, reason: gateCheck.reason, retryAfterMs: gateCheck.retryAfterMs });
  return;
}
```

This closes the uncoordinated second trigger path (audit finding 1) — the
30-min poll can no longer fire browser auth while offline, cooled-down,
suppression-windowed, or budget-exhausted.

## 5. Recovery pass — single coalesced orchestrator (after `healthMonitor.start()`, ~line 151)

```ts
let recoveryInFlight = false; // flap guard — one pass per offline episode
connectivity.on('online', () => {
  if (recoveryInFlight) return;
  recoveryInFlight = true;
  void (async () => {
    try {
      logger.info('connectivity restored — running recovery pass');
      resetAllFailureBackoff();
      const scheduled = await scheduleStoredTokenRefreshes(storage, registry, scheduler, logger, {
        lifecycleStore,
        jitterMs: 5_000,
      });
      logger.info('recovery pass scheduled refreshes', { scheduled });
    } catch (err) {
      logger.warn('recovery pass failed', { error: (err as Error).message });
    } finally {
      connectivity.markOnline();   // completes recovering → online
      recoveryInFlight = false;
    }
  })();
});
```

Notes:
- The pass only SCHEDULES (staggered: overdue = now + 30s + i*10s + jitter);
  actual refreshes run through the scheduler → broker → acquireGate, so the AD
  budget still applies during recovery.
- `markOnline()` is also self-healing: the gate auto-completes the transition
  on its next successful cached probe if this callback ever fails to run.

### Ordering relative to the sibling's browserRegistry init

Place this `connectivity.on('online', ...)` subscription AFTER the sibling's
browser registry initialization in the same `start` block. The recovery pass
schedules refreshes that may fall back to `provider.acquire()` → browser
launch; the registry/reaper must be live first. Required order inside `start`:

1. `installProviders(registry)` (existing, line 93)
2. *(sibling)* browserRegistry / reaper init
3. `connectivity.start()` + validator (step 1 above)
4. scheduler (step 2), broker + `broker.init()` (step 3)
5. `scheduleStoredTokenRefreshes(...)` (existing line 132)
6. healthMonitor with gated `onWarning` (step 4)
7. `connectivity.on('online', ...)` recovery orchestrator (step 5)
8. `http.listen(...)`

## 6. HTTP server deps (~line 153)

```ts
const http = buildHttpServer({
  broker, registry, clientToken: init.clientToken, logger, storage,
  healthMonitor, fleetSync, lifecycleStore, orgRunbooks,
  consumerRateLimit: config.consumerRateLimit,
});
```

## 7. Shutdown (~lines 158-165)

Add `connectivity.stop();` to the `shutdown` function, next to
`healthMonitor.stop()`.

## Interaction with the sibling's BrowserAuthTimeoutError

No wiring needed: `BrowserAuthTimeoutError` carries `retryable=true` and rides
the existing transient classification in `broker.ts` (`isRetryableAuthFailure`,
lines 17-19 — untouched by Workstream B). Timed-out acquires count against the
AD budget (attempts are recorded at attempt-start, before the reaper can kill
the browser), which is the intended behavior — a killed browser attempt still
loaded AD.
