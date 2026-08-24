#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { getHermesVault } from '@hermes/vault';
import { loadConfig, defaultDataDir } from './config.js';
import { initDataDir } from './bootstrap.js';
import { createLogger } from './logger.js';
import { TokenStorage, createKeytarAdapter } from './storage.js';
import { ServiceRegistry } from './registry.js';
import { TokenValidator } from './validator.js';
import { Broker } from './broker.js';
import { ThvTokenStorage } from './thv-storage.js';
import { RefreshScheduler } from './scheduler.js';
import type { DownstreamAuthProbeConfig, TokenBundle } from './types.js';
import { buildHttpServer } from './http-server.js';
import { TokenHealthMonitor } from './health-monitor.js';
import { GatewayFleetSync } from './fleet-sync.js';
import { scheduleStoredTokenRefreshes, scheduleTokenRefresh, scheduleFailureRetry, clearFailureBackoff, resetAllFailureBackoff } from './lifecycle.js';
import { ConnectivityGate } from './connectivity.js';
import { LifecycleStateStore } from './lifecycle-state.js';
import { propagateTokenToToolHive } from './token-propagation.js';
import { formatDoctorReport, runRuntimeDoctor } from './runtime-doctor.js';
import { formatOperatorSummary, summarizeOperatorHealth, summarizeOperatorTimeline, type TokenHealthLike } from './operator-ux.js';
import { OrgRunbookRegistry } from './org-runbook-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import to break circular build dep
const importDynamic = (specifier: string): Promise<any> => import(specifier);

/** Providers that hold disposable resources (persistent browsers, proxies, timers). */
interface DisposableProvider { dispose(): Promise<void> }

function hasDispose(provider: unknown): provider is DisposableProvider {
  return typeof (provider as { dispose?: unknown }).dispose === 'function';
}

/**
 * Read a secret value for `hermes creds set` — NEVER from argv (process listings
 * leak argv). Piped stdin (non-TTY) is read in full, trailing newline stripped.
 * An interactive TTY gets a hidden prompt: readline's internal `_writeToOutput`
 * is overridden to suppress echo of the typed characters (there is no public
 * Node API for masked input; this is the standard workaround).
 */
async function readSecretValue(promptLabel: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n+$/, '');
  }
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const rlHiddenOutput = rl as unknown as { _writeToOutput: (chunk: string) => void };
    let echoSuppressed = false;
    rlHiddenOutput._writeToOutput = (chunk: string) => {
      if (!echoSuppressed) process.stdout.write(chunk);
    };
    rl.question(promptLabel, (answer: string) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
    echoSuppressed = true;
  });
}

async function installProviders(registry: ServiceRegistry): Promise<unknown[]> {
  const installed: unknown[] = [];
  const install = (provider: { name: string }) => {
    registry.installProvider(provider as Parameters<ServiceRegistry['installProvider']>[0]);
    installed.push(provider);
  };
  const { Ms365Provider } = await importDynamic('@hermes/provider-ms365');
  const { PlaywrightBrowserAuth } = await importDynamic('@hermes/auth-core');
  const { defaultFetcher } = await importDynamic('@hermes/auth-core');
  install(new Ms365Provider({
    browser: new PlaywrightBrowserAuth(),
    fetcher: defaultFetcher,
    now: () => Date.now(),
  }));

  const { ServiceNowProvider } = await importDynamic('@hermes/provider-servicenow');
  install(new ServiceNowProvider({ now: () => Date.now() }));

  const { AkamaiWsaProvider } = await importDynamic('@hermes/provider-akamai-wsa');
  install(new AkamaiWsaProvider({ now: () => Date.now() }));

  const { OAuth2Provider } = await importDynamic('@hermes/provider-oauth2');
  install(new OAuth2Provider({
    browser: new PlaywrightBrowserAuth(),
    fetcher: defaultFetcher,
    now: () => Date.now(),
  }));

  const { CrowdStrikeProvider } = await importDynamic('@hermes/provider-crowdstrike');
  install(new CrowdStrikeProvider({ now: () => Date.now() }));

  const { DynatraceProvider } = await importDynamic('@hermes/provider-dynatrace');
  install(new DynatraceProvider({ now: () => Date.now() }));

  const { CookieSessionProvider } = await importDynamic('@hermes/provider-cookie-session');
  install(new CookieSessionProvider({ now: () => Date.now() }));

  const { AzTeamsProvider } = await importDynamic('@hermes/provider-az-teams');
  install(new AzTeamsProvider({
    fetcher: defaultFetcher,
    now: () => Date.now(),
  }));

  const { AzureKeyVaultProvider } = await importDynamic('@hermes/provider-azure-keyvault');
  install(new AzureKeyVaultProvider({ now: () => Date.now() }));

  return installed;
}

const program = new Command();
program.name('hermes').description('Local MCP auth broker').version('0.0.1');

program.command('init')
  .description('Initialize ~/.hermes with config and client token')
  .option('--data-dir <path>', 'data directory', defaultDataDir())
  .action(async (opts: { dataDir: string }) => {
    const result = await initDataDir(opts.dataDir);
    console.log(`initialized ${result.dataDir}`);
    console.log(`config:        ${result.configPath}`);
    console.log(`client token:  ${result.clientTokenPath}`);
  });

program.command('start')
  .description('Start Hermes broker (HTTP API + MCP at /mcp)')
  .option('--data-dir <path>', 'data directory', defaultDataDir())
  .action(async (opts: { dataDir: string }) => {
    const init = await initDataDir(opts.dataDir);
    const config = await loadConfig({ dataDir: init.dataDir });
    const logger = createLogger({ level: config.logLevel, pretty: false });
    const keyring = await createKeytarAdapter();
    const storage = new TokenStorage(keyring);
    const registry = new ServiceRegistry(config.dataDir);
    await registry.loadServices();
    const installedProviders = await installProviders(registry);

    // Browser lifecycle: reap orphaned headless browsers left by dead prior
    // broker incarnations, then start the periodic age-based reaper.
    const { browserRegistry } = await importDynamic('@hermes/auth-core');
    try {
      const reapedCount = await browserRegistry.reapPriorIncarnations({ logger });
      logger.info('prior-incarnation browser reap complete', { reaped: reapedCount });
    } catch (err) {
      logger.warn('prior-incarnation browser reap failed', { error: (err as Error).message });
    }
    const stopReaper: () => void = browserRegistry.startReaper();

    const connectivity = new ConnectivityGate({ logger, config: config.connectivity });
    connectivity.start();
    const validator = new TokenValidator({
      policy: config.validationPolicy,
      safetyMarginSec: config.refreshSafetyMarginSec,
      validationGate: (service, scheme) => broker.validationGate(service, scheme),
    });
    const lifecycleStore = new LifecycleStateStore(config.dataDir);
    let orgRunbooks = new OrgRunbookRegistry();
    try {
      orgRunbooks = await OrgRunbookRegistry.load(config.dataDir);
    } catch (err) {
      logger.warn('org runbook registry ignored', { error: (err as Error).message });
    }
    const thvStorage = new ThvTokenStorage({ logger });
    const fleetSync = new GatewayFleetSync({ logger });
    let broker: Broker;
    const failureRetryOptions = { connectivity, offlineRearmMs: config.connectivity.offlineRecheckMs * 2 };
    const scheduler = new RefreshScheduler({
      logger,
      refresh: async (service, scheme) => {
        if (!await connectivity.isOnline()) {
          logger.info('offline: skipping scheduled refresh', { service, scheme });
          scheduleFailureRetry(scheduler, service, scheme, new Error('offline'), logger, failureRetryOptions);
          return;
        }
        await broker.getToken(service, scheme, { refresh: true });
      },
      onRefreshFailed: (service, scheme, error) => {
        scheduleFailureRetry(scheduler, service, scheme, error, logger, failureRetryOptions);
      },
    });
    const onTokenRefreshed = async (bundle: TokenBundle) => {
      const reg = registry.getService(bundle.service);
      clearFailureBackoff(bundle.service, bundle.scheme);
      await scheduleTokenRefresh(registry, scheduler, bundle, logger, undefined, lifecycleStore);
      if (!reg?.thvSecretPrefix || !reg?.thvContainerName) return;
      // The ToolHive push is an OPTIONAL downstream propagation, NOT part of the
      // capture's success. It fails whenever thv/Docker is unreachable in the
      // broker's launchd environment (`Command failed: thv start <svc>`), even
      // though the fresh bundle was already stored by the broker before this
      // callback ran. If we let that throw propagate, the broker classifies a
      // SUCCESSFULLY-CAPTURED-AND-STORED refresh as a failure: it logs
      // "scheduled refresh failed, keeping cached token", records a REFRESH_FAILED
      // /proof-degraded, and bumps the proactive-failure counter toward the
      // MAX_PROACTIVE_REFRESH_FAILURES disarm — so a service whose push always
      // fails stops self-refreshing and goes stale despite every capture working.
      // Pull-wired containers (e.g. servicenow) fetch tokens from /token and do
      // not need the push at all. Swallow the push failure: the served token is
      // already fresh; the push is best-effort proof, not a gate.
      try {
        await propagateTokenToToolHive(bundle, { registry, thvStorage, fleetSync, lifecycleStore, logger });
      } catch (err) {
        logger.warn('optional ToolHive propagation failed; fresh token already stored and served (push is best-effort, not a refresh gate)', {
          service: bundle.service,
          scheme: bundle.scheme,
          error: (err as Error).message,
        });
      }
    };
    const escapeAppleScript = (s: string) => s.replace(/[\\"]/g, c => '\\' + c).replace(/[\r\n]/g, ' ');
    const onOperatorActionRequired = (payload: { service: string; scheme: string; reason: string; remediation: string; actionClass: string }) => {
      logger.error('operator action required', payload);
      try {
        const title = escapeAppleScript(`Hermes: ${payload.service}/${payload.scheme}`);
        const msg = escapeAppleScript(`${payload.reason}  Fix: ${payload.remediation}`);
        execFileSync('osascript', ['-e', `display notification "${msg}" with title "${title}" sound name "Purr"`], { timeout: 5000, stdio: 'ignore' });
      } catch { /* best-effort desktop notification */ }
    };
    const onRefreshFailed = (service: string, scheme: string, error: Error) => {
      scheduleFailureRetry(scheduler, service, scheme, error, logger, failureRetryOptions);
    };
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
    await broker.init();
    await scheduleStoredTokenRefreshes(storage, registry, scheduler, logger, { lifecycleStore });
    const healthMonitor = new TokenHealthMonitor({
      storage, logger, lifecycleStore,
      onWarning: (health) => {
        if (health.status !== 'expiring') return;
        if (!registry.autoReacquireEnabled(health.service)) return;
        if (connectivity.getState() !== 'online') {
          logger.info('offline: skipping proactive reacquire from health warning', { service: health.service, scheme: health.scheme });
          return;
        }
        const gateCheck = broker.canAttemptAcquire(health.service, health.scheme);
        if (!gateCheck.ok) {
          logger.info('proactive reacquire suppressed by acquire gate', { service: health.service, scheme: health.scheme, reason: gateCheck.reason, retryAfterMs: gateCheck.retryAfterMs });
          return;
        }
        // Backstop: proactively reacquire tokens approaching expiry (before
        // they die). The primary mechanism is the scheduler's reacquire-ahead
        // timer (Phase 2b); this 30-min poll catches tokens that missed their
        // timer (laptop sleep, boot with already-expiring token, scheduler
        // re-arm on slow cadence after auth-required failure).
        // mutex.runDedup + inFlightAcquires in broker.getToken coalesce this
        // with any in-flight scheduler acquire — no double browser launch.
        void broker.getToken(health.service, health.scheme, { force: true })
          .catch((err) => logger.warn('proactive reacquire from health warning failed', {
            service: health.service, scheme: health.scheme, error: (err as Error).message,
          }));
      },
    });
    healthMonitor.start();
    fleetSync.start();

    // Recovery orchestrator: single coalesced refresh pass per offline episode.
    // Subscribed after browserRegistry init — the pass may fall back to
    // provider.acquire() → browser launch, so the registry/reaper must be live.
    let recoveryInFlight = false;
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
          connectivity.markOnline();
          recoveryInFlight = false;
        }
      })();
    });

    const http = buildHttpServer({
      broker, registry, clientToken: init.clientToken, logger, storage,
      healthMonitor, fleetSync, lifecycleStore, orgRunbooks,
      consumerRateLimit: config.consumerRateLimit,
    });
    await http.listen({ host: config.httpHost, port: config.httpPort });
    logger.info('http listening', { host: config.httpHost, port: config.httpPort });
    logger.info('mcp endpoint ready at /mcp');

    let shuttingDown = false;
    const shutdown = async (exitCode = 0) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('shutting down', { exitCode });
      // Hard deadline: if any close/dispose path hangs, force-exit rather than
      // leaving a zombie broker holding the port and child browsers.
      const forceExitTimer = setTimeout(() => {
        logger.error('shutdown deadline (10s) exceeded; forcing exit', {});
        process.exit(1);
      }, 10_000);
      forceExitTimer.unref?.();
      stopReaper();
      connectivity.stop();
      healthMonitor.stop();
      fleetSync.stop();
      scheduler.cancelAll();
      try {
        const killedCount = await browserRegistry.killAll();
        if (killedCount > 0) logger.info('killed managed browsers on shutdown', { count: killedCount });
      } catch (err) {
        logger.warn('browser killAll failed during shutdown', { error: (err as Error).message });
      }
      for (const provider of installedProviders) {
        if (!hasDispose(provider)) continue;
        try {
          await provider.dispose();
        } catch (err) {
          logger.warn('provider dispose failed during shutdown', { error: (err as Error).message });
        }
      }
      await http.close();
      process.exit(exitCode);
    };
    // Wrap: a signal handler receives the signal name as its first argument,
    // which would otherwise land in `exitCode`.
    process.on('SIGINT', () => { void shutdown(0); });
    process.on('SIGTERM', () => { void shutdown(0); });

    // An unhandled rejection terminates the process by default on Node 20, so
    // one stray rejection anywhere (a provider, a transport) takes the broker
    // down and every consumer with it. Log it in full and keep serving: the
    // request that produced it already failed, and the rest of the fleet's
    // credentials are unaffected.
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('unhandled promise rejection; broker continuing', {
        error: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
        promise: String(promise),
      });
    });

    // An uncaught exception leaves the process in an undefined state, so the
    // honest move is to die and let the supervisor restart us. Exit NONZERO so
    // launchd KeepAlive treats it as a crash. Route through `shutdown` rather
    // than around it, so the existing 10s deadline still force-exits if a
    // close/dispose path hangs and would otherwise leave a zombie on port 9876.
    process.on('uncaughtException', (err) => {
      logger.error('uncaught exception; shutting down for supervisor restart', {
        error: err.message,
        stack: err.stack,
      });
      void shutdown(1);
    });
  });

program.command('doctor')
  .description('Diagnose Hermes runtime, launchd, MCP, token health, and recovery readiness')
  .option('--data-dir <path>', 'data directory', defaultDataDir())
  .option('--host <host>', 'broker host')
  .option('--port <port>', 'broker port', (value) => Number.parseInt(value, 10))
  .option('--json', 'print structured JSON')
  .option('--install-launchd', 'install or update the launchd LaunchAgent plist')
  .option('--node-extra-ca-certs <path>', 'NODE_EXTRA_CA_CERTS path to write into the LaunchAgent plist')
  .option('--recover-orphan', 'safely SIGTERM one classified orphan Hermes listener and kickstart launchd')
  .action(async (opts: {
    dataDir: string;
    host?: string;
    port?: number;
    json?: boolean;
    installLaunchd?: boolean;
    nodeExtraCaCerts?: string;
    recoverOrphan?: boolean;
  }) => {
    const config = await loadConfig({ dataDir: opts.dataDir });
    const report = await runRuntimeDoctor({
      dataDir: config.dataDir,
      host: opts.host ?? config.httpHost,
      port: opts.port ?? config.httpPort,
      installLaunchd: Boolean(opts.installLaunchd),
      recoverOrphan: Boolean(opts.recoverOrphan),
      nodeExtraCaCerts: opts.nodeExtraCaCerts,
    });
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
    if (!report.ok) process.exitCode = 1;
  });

program.command('status')
  .description('Show redacted auth operator health, degraded services, exact next action, and evidence')
  .option('--data-dir <path>', 'data directory', defaultDataDir())
  .option('--json', 'print structured JSON')
  .action(async (opts: { dataDir: string; json?: boolean }) => {
    const init = await initDataDir(opts.dataDir);
    const config = await loadConfig({ dataDir: init.dataDir });
    const logger = createLogger({ level: config.logLevel, pretty: false });
    const keyring = await createKeytarAdapter();
    const storage = new TokenStorage(keyring);
    const registry = new ServiceRegistry(config.dataDir);
    await registry.loadServices();
    await installProviders(registry).catch(() => {/* best-effort: provider caps are advisory */});
    const lifecycleStore = new LifecycleStateStore(config.dataDir);
    const monitor = new TokenHealthMonitor({ storage, logger, lifecycleStore });
    let orgRunbooks = new OrgRunbookRegistry();
    let orgMetadataError: unknown;
    try {
      orgRunbooks = await OrgRunbookRegistry.load(config.dataDir);
    } catch (err) {
      orgMetadataError = err;
    }
    let tokens: TokenHealthLike[];
    let inventoryError: unknown;
    try {
      const health = await monitor.runCheck();
      tokens = await Promise.all(health.map(async (h) => ({
        service: h.service,
        scheme: h.scheme,
        status: h.status,
        proof: h.proof,
        accessTokenExpiresAt: h.accessTokenExpiresAt,
        refreshTokenAge: h.refreshTokenAge,
        lifecycle: await lifecycleStore.get(h.service, h.scheme).catch(() => null) ?? undefined,
      })));
    } catch (err) {
      inventoryError = err;
      tokens = (await lifecycleStore.list().catch(() => [])).map((state) => ({
        service: state.service,
        scheme: state.scheme,
        status: 'unknown',
        lifecycle: state,
      }));
    }
    const summary = summarizeOperatorHealth(tokens, { inventoryError, orgRunbooks: orgRunbooks.list(), orgMetadataError, registry });
    console.log(opts.json ? JSON.stringify(summary, null, 2) : formatOperatorSummary(summary));
    if (summary.status !== 'healthy') process.exitCode = 1;
  });

program.command('timeline')
  .description('Show redacted latest auth proof/propagation/lifecycle events from persisted lifecycle state')
  .option('--data-dir <path>', 'data directory', defaultDataDir())
  .option('--limit <n>', 'maximum number of events', (value) => Number.parseInt(value, 10), 20)
  .option('--json', 'print structured JSON')
  .action(async (opts: { dataDir: string; limit: number; json?: boolean }) => {
    const init = await initDataDir(opts.dataDir);
    const config = await loadConfig({ dataDir: init.dataDir });
    const lifecycleStore = new LifecycleStateStore(config.dataDir);
    const tokens = (await lifecycleStore.list().catch(() => [])).map((state) => ({
      service: state.service,
      scheme: state.scheme,
      status: 'unknown',
      lifecycle: state,
    }));
    const events = summarizeOperatorTimeline(tokens, Math.max(1, Math.min(100, opts.limit || 20)));
    if (opts.json) {
      console.log(JSON.stringify({ events, schemaReady: true }, null, 2));
    } else if (events.length === 0) {
      console.log('Hermes auth timeline: no lifecycle events recorded yet');
    } else {
      console.log('Hermes auth timeline:');
      for (const event of events) {
        console.log(`- ${event.at} ${event.service}/${event.scheme} ${event.kind}${event.status ? ` ${event.status}` : ''}${event.message ? ` — ${event.message}` : ''}`);
      }
    }
  });

program
  .command('register <service>')
  .description('Register a service with a provider')
  .requiredOption('--provider <name>', 'provider name')
  .requiredOption('--scheme <scheme...>', 'one or more schemes')
  .requiredOption('--config <json>', 'provider config as JSON string')
  .option('--thv-secret-prefix <prefix>', 'thv secret name prefix (e.g. MS365)')
  .option('--thv-container <name>', 'thv container to restart after token refresh')
  .option('--auth-probe <json>', 'safe read-only authenticated downstream MCP probe JSON')
  .option('--data-dir <path>', 'data directory', defaultDataDir())
  .action(async (service: string, opts: { provider: string; scheme: string[]; config: string; dataDir: string; thvSecretPrefix?: string; thvContainer?: string; authProbe?: string }) => {
    await initDataDir(opts.dataDir);
    const config = await loadConfig({ dataDir: opts.dataDir });
    const registry = new ServiceRegistry(config.dataDir);
    await registry.loadServices();
    await installProviders(registry);
    let parsedConfig: Record<string, unknown>;
    try { parsedConfig = JSON.parse(opts.config); }
    catch (err) { console.error(`invalid --config JSON: ${(err as Error).message}`); process.exit(2); }
    let parsedAuthProbe: DownstreamAuthProbeConfig | undefined;
    if (opts.authProbe) {
      try { parsedAuthProbe = JSON.parse(opts.authProbe) as DownstreamAuthProbeConfig; }
      catch (err) { console.error(`invalid --auth-probe JSON: ${(err as Error).message}`); process.exit(2); }
    }
    await registry.registerService({
      name: service, providerName: opts.provider, schemes: opts.scheme,
      config: parsedConfig, createdAt: Date.now(),
      ...(opts.thvSecretPrefix && { thvSecretPrefix: opts.thvSecretPrefix }),
      ...(opts.thvContainer && { thvContainerName: opts.thvContainer }),
      ...(parsedAuthProbe && { downstreamAuthProbe: parsedAuthProbe }),
    });
    console.log(`registered service ${service} with provider ${opts.provider}`);
  });

program
  .command('acquire <service>')
  .description('Interactively acquire tokens for a registered service')
  .option('--data-dir <path>', 'data directory', defaultDataDir())
  .action(async (service: string, opts: { dataDir: string }) => {
    const { runAcquire } = await import('./acquire.js');
    const init = await initDataDir(opts.dataDir);
    const config = await loadConfig({ dataDir: init.dataDir });
    const logger = createLogger({ level: config.logLevel, pretty: true });
    const keyring = await createKeytarAdapter();
    const storage = new TokenStorage(keyring);
    const registry = new ServiceRegistry(config.dataDir);
    await registry.loadServices();
    await installProviders(registry);
    const validator = new TokenValidator({ policy: config.validationPolicy, safetyMarginSec: config.refreshSafetyMarginSec });
    const lifecycleStore = new LifecycleStateStore(config.dataDir);
    const broker = new Broker({ storage, registry, validator, logger, dataDir: config.dataDir, lifecycleStore });
    const registration = registry.getService(service);
    if (!registration) { console.error(`service ${service} is not registered`); process.exit(2); }
    console.log(`acquiring tokens for ${service} (schemes: ${registration.schemes.join(', ')}) — headless mode`);
    const result = await runAcquire({ broker, service, schemes: registration.schemes, interactive: false });
    console.log(`acquired: ${result.acquired.join(', ') || '(none)'}`);
    if (result.failed.length > 0) {
      console.error('failed:');
      for (const f of result.failed) console.error(`  ${f.scheme}: ${f.error}`);
      process.exit(1);
    }
  });

const credsCommand = program.command('creds')
  .description('Manage credentials in the Hermes vault (SSO source creds, TOTP seeds, etc.)');

credsCommand
  .command('set <service> <account>')
  .description('Store a credential value — read from stdin (if piped) or a hidden prompt, never from argv')
  .action(async (service: string, account: string) => {
    const value = await readSecretValue(`value for ${service}::${account}: `);
    if (!value) { console.error('no value provided'); process.exit(2); }
    const vault = await getHermesVault();
    await vault.set(service, account, value);
    console.log(`stored ${service}::${account}`);
  });

credsCommand
  .command('list <service>')
  .description('List stored credential account names for a service (values are never shown)')
  .option('--json', 'emit structured JSON ([{ account, updatedAt }]) instead of plain lines')
  .action(async (service: string, opts: { json?: boolean }) => {
    const vault = await getHermesVault();
    const entries = await vault.listEntries(service);
    if (opts.json) {
      console.log(JSON.stringify(entries.map(({ account, updatedAt }) => ({ account, updatedAt })), null, 2));
      return;
    }
    if (entries.length === 0) { console.log(`no credentials stored for service ${service}`); return; }
    for (const { account } of entries) console.log(`${service}::${account}`);
  });

// Cross-service enumeration — findCredentials/the `list` command above are
// scoped to one service namespace (mirrors the existing KeyringAdapter
// contract — see storage.ts), so knowing every service that HAS a credential
// requires this separate primitive (HermesVault.listEntries with no filter).
credsCommand
  .command('services')
  .description('List every service with at least one stored credential (values are never shown)')
  .option('--json', 'emit structured JSON ([{ service, accounts: [{ account, updatedAt }] }])')
  .action(async (opts: { json?: boolean }) => {
    const vault = await getHermesVault();
    const entries = await vault.listEntries();
    if (opts.json) {
      const byService = new Map<string, Array<{ account: string; updatedAt: string }>>();
      for (const e of entries) {
        const accounts = byService.get(e.service) ?? [];
        accounts.push({ account: e.account, updatedAt: e.updatedAt });
        byService.set(e.service, accounts);
      }
      const out = Array.from(byService.entries()).map(([service, accounts]) => ({ service, accounts }));
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    if (entries.length === 0) { console.log('no credentials stored'); return; }
    for (const e of entries) console.log(`${e.service}::${e.account}`);
  });

credsCommand
  .command('show <service> <account>')
  .description('Show non-secret metadata for a stored credential — updatedAt only, never the value')
  .option('--json', 'emit JSON ({ service, account, updatedAt })')
  .action(async (service: string, account: string, opts: { json?: boolean }) => {
    const vault = await getHermesVault();
    const entries = await vault.listEntries(service);
    const entry = entries.find((e) => e.account === account);
    if (!entry) {
      console.error(`no credential found for ${service}::${account}`);
      process.exit(1);
    }
    if (opts.json) {
      console.log(JSON.stringify({ service, account, updatedAt: entry.updatedAt }));
      return;
    }
    console.log(`${service}::${account} — updated ${entry.updatedAt}`);
  });

credsCommand
  .command('delete <service> <account>')
  .description('Delete a stored credential')
  .action(async (service: string, account: string) => {
    const vault = await getHermesVault();
    const deleted = await vault.delete(service, account);
    if (deleted) { console.log(`deleted ${service}::${account}`); return; }
    console.error(`no credential found for ${service}::${account}`);
    process.exit(1);
  });

program.parseAsync(process.argv);
