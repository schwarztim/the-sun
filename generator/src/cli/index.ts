#!/usr/bin/env node

/**
 * thesun CLI
 *
 * Command-line interface for the autonomous MCP server generation platform.
 */

import { Command } from 'commander';
import { createOrchestrator } from '../orchestrator/index.js';
import { ToolSpec, ToolSpecSchema } from '../types/index.js';
import { logger } from '../observability/logger.js';
import { getDefaultDataDir, getDefaultConfigDir } from '../utils/platform.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { runLab } from '../lab/index.js';
import { mkdirSync, writeFileSync } from 'fs';
import {
  generateGoServer,
  endpointsFromDiscovery,
  GoServerConfig,
  GoEndpointSpec,
} from '../generator/go-generator.js';
import { detectHardcodedConfig } from '../generator/config-abstraction.js';
import { openApiToDiscovery, isOpenApiDocument } from '../generator/openapi-to-discovery.js';
import { resolveGoSpecFromName } from '../generator/resolve-go-spec.js';
import { parse as parseYaml } from 'yaml';

const program = new Command();

/**
 * Deterministic `--lang go` path.
 *
 * Reads a spec file and writes a compilable Go MCP server (main.go + go.mod +
 * Dockerfile + support files) to the output dir. Three input shapes are
 * accepted, in JSON or YAML:
 *   1. A raw OpenAPI 3.x or Swagger 2.0 document (converted in-process to a
 *      discovery-result via `openApiToDiscovery`).
 *   2. A thesun discovery-result (top-level metadata plus an `endpoints` array
 *      in DiscoveredEndpoint shape, params carrying an `in` field).
 *   3. A hand-assembled GoServerConfig (raw `endpoints` in GoEndpointSpec shape).
 *
 * This bypasses the agentic "bob" orchestrator on purpose: Go output is produced
 * by the deterministic generator so it is verifiable with `go build ./...`.
 */
interface GoGenerationOptions {
  file?: string;
  output?: string;
  tool: string[];
  dryRun?: boolean;
  /** GEN-5: a bare service/API name (from a positional arg) to discover. */
  name?: string;
}

/**
 * Resolve the raw spec object for the Go path from EITHER a `--file` (GEN-4:
 * OpenAPI/Swagger, discovery-result, or GoServerConfig; JSON or YAML) OR a bare
 * service name (GEN-5: discovered via apis.guru and converted). Returns the
 * discovery-result/GoServerConfig object `emitGoServer` consumes. Exits the
 * process with a clear message on any unrecoverable condition.
 */
async function loadGoRaw(options: GoGenerationOptions): Promise<Record<string, unknown>> {
  const bareName = (options.name ?? options.tool[0] ?? '').trim();

  // GEN-5: no --file but a bare name present -> discover a public spec.
  if (!options.file) {
    if (!bareName) {
      console.error(
        'Error: --lang go requires either --file <spec> (an OpenAPI 3.x / Swagger 2.0 spec, a ' +
          'discovery-result, or a GoServerConfig; JSON or YAML) OR a bare service name ' +
          '(e.g. `thesun generate --lang go stripe`).',
      );
      process.exit(1);
    }

    console.log(`🔎 No --file given; discovering a public OpenAPI spec for "${bareName}" via apis.guru...\n`);
    const { discovery, warnings, specUrl } = await resolveGoSpecFromName(bareName);
    for (const w of warnings) {
      console.error(`   ⚠️  ${w}`);
    }
    if (!discovery) {
      console.error(
        `\nNo public OpenAPI spec found for ${bareName} on apis.guru. ` +
          'Provide one with `--lang go --file <spec.yaml>`, or use `--lang python -t ' +
          `${bareName}\` for the agentic discovery path.`,
      );
      process.exit(1);
    }
    console.log(`   ✅ Resolved spec: ${specUrl}\n`);
    return discovery as unknown as Record<string, unknown>;
  }

  // GEN-4: --file path (unchanged behavior).
  if (!existsSync(options.file)) {
    console.error(`Error: File not found: ${options.file}`);
    process.exit(1);
  }

  // Load the spec, supporting both JSON and YAML. YAML is the common format for
  // OpenAPI specs. Parse as YAML when the extension is .yaml/.yml, or fall back
  // to YAML if JSON.parse fails (YAML is a JSON superset, so this stays safe).
  const fileText = readFileSync(options.file, 'utf-8');
  const isYamlExt = /\.(ya?ml)$/i.test(options.file);
  let raw: Record<string, unknown>;
  try {
    raw = (isYamlExt ? parseYaml(fileText) : JSON.parse(fileText)) as Record<string, unknown>;
  } catch (jsonErr) {
    if (isYamlExt) {
      console.error(`Error: could not parse ${options.file} as YAML: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
      process.exit(1);
    }
    try {
      raw = parseYaml(fileText) as Record<string, unknown>;
    } catch (yamlErr) {
      console.error(`Error: could not parse ${options.file} as JSON or YAML: ${yamlErr instanceof Error ? yamlErr.message : String(yamlErr)}`);
      process.exit(1);
    }
  }

  // GEN-4: if the file is a raw OpenAPI/Swagger document, convert it to the
  // discovery-result shape BEFORE the discovery-shape detection, so the rest of
  // the flow is unchanged. Non-OpenAPI inputs pass through untouched.
  if (isOpenApiDocument(raw)) {
    try {
      raw = openApiToDiscovery(raw, { name: bareName || undefined }) as unknown as Record<string, unknown>;
    } catch (convErr) {
      console.error(`Error: ${convErr instanceof Error ? convErr.message : String(convErr)}`);
      process.exit(1);
    }
  }

  return raw;
}

/**
 * Deterministic `--lang go` entry point. Loads the raw spec (file or bare-name
 * discovery), then emits the Go server. Async because bare-name discovery hits
 * the network (apis.guru).
 */
async function runGoGeneration(options: GoGenerationOptions): Promise<void> {
  const raw = await loadGoRaw(options);
  emitGoServer(raw, options);
}

/**
 * Build a GoServerConfig from a discovery-result/GoServerConfig object, run the
 * pre-write secret scan, and write the Go MCP server to disk (or dry-run).
 * Calls process.exit with the appropriate code.
 */
function emitGoServer(raw: Record<string, unknown>, options: GoGenerationOptions): void {
  // Detect discovery-result endpoints (params carry an `in` field) vs raw GoEndpointSpec.
  const rawEndpoints = (raw.endpoints ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(rawEndpoints) || rawEndpoints.length === 0) {
    console.error('Error: spec has no `endpoints` array.');
    process.exit(1);
  }
  const isDiscoveryShape = rawEndpoints.some(
    (e) => Array.isArray(e.parameters) && (e.parameters as Array<Record<string, unknown>>).some((p) => 'in' in p),
  );

  const endpoints: GoEndpointSpec[] = isDiscoveryShape
    ? endpointsFromDiscovery(rawEndpoints as Parameters<typeof endpointsFromDiscovery>[0])
    : (rawEndpoints as unknown as GoEndpointSpec[]);

  const name = (raw.name as string) ?? (raw.toolName as string) ?? options.tool[0] ?? 'service';
  const baseUrl = (raw.baseUrl as string) ?? '';

  const config: GoServerConfig = {
    name,
    version: (raw.version as string) ?? 'dev',
    baseUrl,
    authScheme: (raw.authScheme as GoServerConfig['authScheme']) ?? 'bearer',
    authEnvPrefix: raw.authEnvPrefix as string | undefined,
    apiKeyQueryParam: raw.apiKeyQueryParam as string | undefined,
    apiKeyHeader: raw.apiKeyHeader as string | undefined,
    defaultPort: raw.defaultPort as string | undefined,
    rateLimitRPS: raw.rateLimitRPS as number | undefined,
    rateLimitBurst: raw.rateLimitBurst as number | undefined,
    hermesTokenService: raw.hermesTokenService as string | undefined,
    hermesTokenScheme: raw.hermesTokenScheme as string | undefined,
    hermesTokenHeader: raw.hermesTokenHeader as string | undefined,
    cookieName: raw.cookieName as string | undefined,
    // Per-target anti-bot capability flag. Accept `antiBot` as an alias.
    requiresBrowserTLS: (raw.requiresBrowserTLS ?? raw.antiBot) as boolean | undefined,
    endpoints,
  };

  // Language-routing note: Go is the default. The Go path performs a
  // browser-realistic TLS ClientHello (uTLS) for the outbound call to the
  // target, matching the fingerprint guarantee thesun's Python (curl_cffi)
  // servers provide, so a target that declares it needs a browser-realistic
  // TLS fingerprint (anti-bot / JA4 evasion) is fully supported on Go. This
  // is informational only; no language switch is required.
  if (config.requiresBrowserTLS) {
    console.error(
      `ℹ️  "${name}" declares requiresBrowserTLS (browser-realistic TLS fingerprint). ` +
        `The Go path presents one via uTLS, so no --lang change is required. Note that the ` +
        `Conformance Lab wire-fingerprint gate does NOT measure it: that gate's JA4 anchors and ` +
        `self-test hook are Python (curl_cffi) only, so it reports Go servers as NOT VERIFIED.`,
    );
  }

  let generated;
  try {
    generated = generateGoServer(config);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Supply-chain guard: scan generated output for secret-shaped strings
  // BEFORE anything is written to disk. HAR/browser-capture-derived
  // generation is exactly where a user's real session cookie can end up
  // hardcoded in emitted source. Uses the same pattern pack as the
  // Conformance Lab's mandatory `thesun verify` gate 5
  // (src/lab/gates/credential-scan.ts -> detectHardcodedConfig), run here
  // too so a leak is caught at generation time rather than only at the
  // later, separately-invoked verify step. Never prints the matched value —
  // only the file and the pattern name that fired.
  const secretFindings: string[] = [];
  for (const [rel, contents] of Object.entries(generated.files)) {
    for (const issue of detectHardcodedConfig(contents)) {
      secretFindings.push(`${rel}: ${issue.split(':')[0]}`);
    }
  }
  if (secretFindings.length > 0) {
    console.error('\n🛑 BLOCKED — secret-shaped string(s) found in generated output:');
    for (const finding of secretFindings) {
      console.error(`   • ${finding}`);
    }
    console.error(
      '\nGeneration refused. A captured credential (e.g. a HAR/browser-session cookie) must never ' +
        'ship hardcoded in generated source — move it to Hermes/env and regenerate. No files were written.',
    );
    process.exit(1);
  }

  const outDir = options.output ?? join(process.cwd(), `${name}-mcp-go`);

  console.log(`🐹 Go target: ${name}-mcp`);
  console.log(`   Endpoints → tools: ${endpoints.length}`);
  console.log(`   Auth scheme: ${config.authScheme}`);
  console.log(`   Output: ${outDir}\n`);

  if (options.dryRun) {
    console.log('🔍 Dry run — files that would be written:');
    for (const path of Object.keys(generated.files)) {
      console.log(`  • ${path}`);
    }
    process.exit(0);
  }

  mkdirSync(outDir, { recursive: true });
  for (const [rel, contents] of Object.entries(generated.files)) {
    writeFileSync(join(outDir, rel), contents, 'utf-8');
    console.log(`  ✅ ${rel}`);
  }

  console.log('\n📦 Go MCP server generated. Verify with:');
  console.log(`   cd ${outDir} && go mod tidy && go build ./...`);
  console.log(`   docker build -t ${name}-mcp .`);
  process.exit(0);
}

program
  .name('thesun')
  .description('Autonomous MCP server generation and orchestration platform')
  .version('0.1.0');

// Generate command
program
  .command('generate')
  .description('Generate an MCP server for one or more tools')
  .argument('[name]', 'Bare service/API name to discover and generate on the Go path (e.g. `stripe`); resolved via apis.guru when no --file is given')
  .option('-t, --tool <name>', 'Tool name to generate (can be repeated)', collect, [])
  .option('-f, --file <path>', 'Spec file: an OpenAPI 3.x / Swagger 2.0 document, a discovery-result, or a GoServerConfig (JSON or YAML)')
  .option('-o, --output <path>', 'Output directory for generated MCP servers')
  .option('--lang <lang>', 'Target language: go (default, native, low-footprint, single shared instance) | python', 'go')
  .option('--parallel <n>', 'Maximum parallel builds', parseInt, 4)
  .option('--skip-security', 'Skip security scans (not recommended)')
  .option('--skip-tests', 'Skip test generation and execution')
  .option('--dry-run', 'Show what would be generated without executing')
  .action(async (nameArg: string | undefined, options) => {
    console.log('🌞 thesun - Autonomous MCP Server Generator\n');

    // --lang go: deterministic Go MCP server generation. Go is the default
    // (native, low-footprint, single shared instance); Python is the opt-in.
    const lang = String(options.lang ?? 'go').toLowerCase();
    if (lang === 'go' || lang === 'golang') {
      // GEN-5: a bare positional name (or -t) with no --file triggers apis.guru
      // discovery inside runGoGeneration. runGoGeneration calls process.exit.
      await runGoGeneration({ ...options, name: nameArg });
      return;
    }
    if (lang !== 'python' && lang !== 'py') {
      console.error(`Error: unsupported --lang "${options.lang}". Use "go" (default) or "python".`);
      process.exit(1);
    }

    // Load tool specs
    let tools: ToolSpec[] = [];

    if (options.file) {
      // Load from file
      if (!existsSync(options.file)) {
        console.error(`Error: File not found: ${options.file}`);
        process.exit(1);
      }

      const content = readFileSync(options.file, 'utf-8');
      const parsed = JSON.parse(content);
      const specs = Array.isArray(parsed) ? parsed : [parsed];

      for (const spec of specs) {
        const result = ToolSpecSchema.safeParse(spec);
        if (result.success) {
          tools.push(result.data);
        } else {
          console.error(`Invalid tool spec: ${JSON.stringify(result.error.errors)}`);
          process.exit(1);
        }
      }
    } else if (options.tool.length > 0) {
      // Create basic specs from tool names
      for (const name of options.tool) {
        tools.push({
          name,
          description: `MCP server for ${name}`,
          category: 'other',
          authType: 'api_key', // Default, can be overridden
        });
      }
    } else {
      console.error('Error: Specify either --tool or --file');
      program.help();
    }

    console.log(`📋 Tools to generate: ${tools.map((t) => t.name).join(', ')}\n`);

    if (options.dryRun) {
      console.log('🔍 Dry run mode - showing plan only\n');
      for (const tool of tools) {
        console.log(`  • ${tool.name}`);
        console.log(`    Category: ${tool.category}`);
        console.log(`    Auth: ${tool.authType}`);
        if (tool.specSources) {
          console.log(`    Specs: ${tool.specSources.map((s) => s.url ?? s.path).join(', ')}`);
        }
        console.log();
      }
      process.exit(0);
    }

    // Create orchestrator
    const orchestrator = createOrchestrator({
      maxParallelBuilds: options.parallel,
      workspace: options.output ?? join(getDefaultDataDir(), 'builds'),
    });

    // Set up event handlers
    orchestrator.on('build:start', (state) => {
      console.log(`🚀 Starting build: ${state.toolName} (${state.id.slice(0, 8)})`);
    });

    orchestrator.on('build:phase', (state, previousPhase) => {
      const phaseEmoji: Record<string, string> = {
        discovering: '🔍',
        generating: '⚙️',
        testing: '🧪',
        security_scan: '🔒',
        optimizing: '⚡',
        validating: '✅',
      };
      console.log(`  ${phaseEmoji[state.phase] ?? '•'} ${state.toolName}: ${state.phase}`);
    });

    orchestrator.on('build:complete', (state) => {
      console.log(`\n✅ Completed: ${state.toolName}`);
      console.log(`   Endpoints: ${state.discovery?.endpoints ?? 0}`);
      console.log(`   Tools generated: ${state.generation?.toolsGenerated ?? 0}`);
      console.log(`   Tests passed: ${state.testing?.passed ?? 0}/${state.testing?.totalTests ?? 0}`);
      console.log(`   Coverage: ${state.testing?.coverage ?? 0}%`);
    });

    orchestrator.on('build:fail', (state, error) => {
      console.error(`\n❌ Failed: ${state.toolName}`);
      console.error(`   Error: ${error.message}`);
    });

    // Queue builds
    const buildIds = await orchestrator.queueBuilds(tools);
    console.log(`\n📥 Queued ${buildIds.length} builds\n`);

    // Wait for completion
    const checkInterval = setInterval(() => {
      const builds = orchestrator.getAllBuilds();
      const completed = builds.filter((b) => b.phase === 'completed' || b.phase === 'failed');

      if (completed.length === builds.length) {
        clearInterval(checkInterval);

        const successful = completed.filter((b) => b.phase === 'completed').length;
        const failed = completed.filter((b) => b.phase === 'failed').length;

        console.log('\n📊 Summary');
        console.log(`   Successful: ${successful}`);
        console.log(`   Failed: ${failed}`);

        orchestrator.shutdown().then(() => {
          process.exit(failed > 0 ? 1 : 0);
        });
      }
    }, 1000);

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log('\n\n⏹️  Shutting down...');
      await orchestrator.shutdown();
      process.exit(0);
    });
  });

// Status command
program
  .command('status')
  .description('Show status of active builds')
  .action(async () => {
    console.log('🌞 thesun - Build Status\n');

    // In a real implementation, would read from persistent state
    console.log('No active builds found.');
    console.log('Use "thesun generate" to start a build.');
  });

// List command
program
  .command('list')
  .description('List available tool templates and examples')
  .action(async () => {
    console.log('🌞 thesun - Available Tool Templates\n');

    const templates = [
      { name: 'observability', examples: ['dynatrace', 'datadog', 'prometheus'] },
      { name: 'security', examples: ['snyk', 'fortify', 'sonarqube'] },
      { name: 'devops', examples: ['github', 'gitlab', 'jenkins'] },
      { name: 'communication', examples: ['slack', 'teams', 'email'] },
      { name: 'data', examples: ['snowflake', 'databricks', 'postgres'] },
    ];

    for (const template of templates) {
      console.log(`📦 ${template.name}`);
      console.log(`   Examples: ${template.examples.join(', ')}\n`);
    }

    console.log('Use "thesun generate --tool=<name>" to generate an MCP server.');
  });

// Config command
program
  .command('config')
  .description('Show or update configuration')
  .option('--show', 'Show current configuration')
  .option('--init', 'Initialize configuration with defaults')
  .action(async (options) => {
    console.log('🌞 thesun - Configuration\n');

    const configDir = getDefaultConfigDir();
    const dataDir = getDefaultDataDir();

    console.log(`Config directory: ${configDir}`);
    console.log(`Data directory: ${dataDir}`);
    console.log();

    console.log('Environment Variables:');
    console.log(`  THESUN_DATA_DIR: ${process.env.THESUN_DATA_DIR ?? '(not set)'}`);
    console.log(`  THESUN_WORKSPACE: ${process.env.THESUN_WORKSPACE ?? '(not set)'}`);
    console.log(`  LOG_LEVEL: ${process.env.LOG_LEVEL ?? 'info'}`);
    console.log(`  MAX_PARALLEL_BUILDS: ${process.env.MAX_PARALLEL_BUILDS ?? '4'}`);
    console.log();

    console.log('Knowledge Sources:');
    console.log(`  Jira: ${process.env.JIRA_BASE_URL ? '✅ configured' : '❌ not configured'}`);
    console.log(`  Confluence: ${process.env.CONFLUENCE_BASE_URL ? '✅ configured' : '❌ not configured'}`);
    console.log(`  ServiceNow: ${process.env.SERVICENOW_INSTANCE ? '✅ configured' : '❌ not configured'}`);
    console.log(`  GitHub: ${process.env.GITHUB_TOKEN ? '✅ configured' : '❌ not configured'}`);
  });

// Verify command — the Conformance Lab
program
  .command('verify <dir>')
  .description('Run the Conformance Lab against a generated MCP server directory (protocol, wire-fingerprint, credential-scan, coverage, and more)')
  .option('--target <name>', 'Target/tool name (defaults to the directory basename)')
  .option('--live', 'Enable the opt-in live-credential smoke path (THESUN_VERIFY_LIVE=1 equivalent)')
  .action(async (dir: string, options: { target?: string; live?: boolean }) => {
    console.log('🔬 thesun verify - Conformance Lab\n');

    if (!existsSync(dir)) {
      console.error(`Error: directory not found: ${dir}`);
      process.exit(1);
    }

    try {
      const report = await runLab({ serverDir: dir, targetName: options.target, live: options.live });
      const reportPath = join(dir, 'lab-report.json');

      console.log(`Target: ${report.target}`);
      console.log(`Transport: ${report.transport ?? '(none — connection failed)'}`);
      console.log(`Tools: ${report.toolCount}\n`);

      for (const gate of report.gates) {
        const icon = gate.skipped ? '⏭️ ' : gate.passed ? '✅' : '❌';
        console.log(`  ${icon} ${gate.gate}: ${gate.message}`);
      }

      console.log(`\nReport written to ${reportPath}`);
      console.log(`Result: ${report.passed ? '✅ PASS' : '❌ FAIL'}`);
      console.log(
        '\nNote — a PASS means structurally valid, alive, and correctly fingerprinted. It does NOT mean:',
      );
      for (const item of report.residualUnverifiedSurface) {
        console.log(`  - ${item}`);
      }

      process.exit(report.passed ? 0 : 1);
    } catch (error) {
      console.error('Lab run failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Helper to collect multiple option values
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

// Parse and run
program.parse();
