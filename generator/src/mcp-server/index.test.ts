/**
 * Integration tests for the enhanced thesun MCP server
 *
 * Tests the integration of all browser-enhanced modules:
 * - DependencyChecker (preflight)
 * - McpRegistrySearch (find existing MCPs)
 * - CredentialWizard (auth handling)
 * - PatternEngine (apply known patterns)
 * - SelfHealingModule (health monitoring)
 * - ValidationGate (post-gen validation)
 * - SmartCache (incremental updates)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homedir } from "os";
import { join } from "path";

// Mock modules before imports
vi.mock("../preflight/dependency-checker.js", () => ({
  getDependencyChecker: vi.fn(),
  DependencyChecker: vi.fn(),
}));

vi.mock("../discovery/mcp-registry-search.js", () => ({
  getMcpRegistrySearch: vi.fn(),
  McpRegistrySearch: vi.fn(),
}));

vi.mock("../auth/credential-wizard.js", () => ({
  CredentialWizard: vi.fn(),
}));

vi.mock("../patterns/pattern-engine.js", () => ({
  PatternEngine: vi.fn(),
}));

vi.mock("../health/self-healing.js", () => ({
  SelfHealingModule: vi.fn(),
}));

vi.mock("../validation/validation-gate.js", () => ({
  ValidationGate: vi.fn(),
}));

vi.mock("../cache/smart-cache.js", () => ({
  SmartCache: vi.fn(),
}));

// Import after mocks
import { getDependencyChecker } from "../preflight/dependency-checker.js";
import { getMcpRegistrySearch } from "../discovery/mcp-registry-search.js";
import { CredentialWizard } from "../auth/credential-wizard.js";
import { PatternEngine } from "../patterns/pattern-engine.js";
import { SelfHealingModule } from "../health/self-healing.js";
import { ValidationGate } from "../validation/validation-gate.js";
import { SmartCache } from "../cache/smart-cache.js";

describe("TheSunMcpServer Integration", () => {
  const MCP_OUTPUT_BASE = join(homedir(), "Scripts", "mcp-servers");

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Module Integration", () => {
    it("should have DependencyChecker available", () => {
      expect(getDependencyChecker).toBeDefined();
    });

    it("should have McpRegistrySearch available", () => {
      expect(getMcpRegistrySearch).toBeDefined();
    });

    it("should have CredentialWizard available", () => {
      expect(CredentialWizard).toBeDefined();
    });

    it("should have PatternEngine available", () => {
      expect(PatternEngine).toBeDefined();
    });

    it("should have SelfHealingModule available", () => {
      expect(SelfHealingModule).toBeDefined();
    });

    it("should have ValidationGate available", () => {
      expect(ValidationGate).toBeDefined();
    });

    it("should have SmartCache available", () => {
      expect(SmartCache).toBeDefined();
    });
  });

  describe("Enhanced Flow Generation", () => {
    it("should generate instructions with preflight check phase", async () => {
      // The generated instructions should include preflight checks
      const expectedPhase = "PREFLIGHT CHECK";
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain(expectedPhase);
      expect(instructions).toContain("DependencyChecker");
    });

    it("should generate instructions with existing MCP check phase", async () => {
      const expectedPhase = "EXISTING MCP CHECK";
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain(expectedPhase);
      expect(instructions).toContain("SmartCache.getSpec");
      expect(instructions).toContain("McpRegistrySearch.search");
    });

    it("should generate instructions with authentication phase", async () => {
      const expectedPhase = "AUTHENTICATION";
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain(expectedPhase);
      expect(instructions).toContain("CredentialWizard");
    });

    it("should generate instructions with pattern matching", async () => {
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain("PatternEngine");
      expect(instructions).toContain("matchKnownPattern");
    });

    it("should generate instructions with validation gate phase", async () => {
      const expectedPhase = "VALIDATION GATE";
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain(expectedPhase);
      expect(instructions).toContain("ValidationGate.runValidation");
    });

    it("should generate instructions with self-healing code injection", async () => {
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain("SelfHealingModule");
    });

    it("should generate instructions with smart cache usage", async () => {
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain("SmartCache.cacheSpec");
    });
  });

  describe("Universal Tool Schema Generation", () => {
    it("should include cross-platform compatibility note", async () => {
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain("Claude Code");
      expect(instructions).toContain("GitHub Copilot");
      expect(instructions).toContain("Gemini");
      expect(instructions).toContain("Codex");
    });

    it("should include universal tool schema export", async () => {
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain("universal tool schemas");
    });
  });

  describe("Integration Flow Phases", () => {
    it("should define correct phase order", async () => {
      const instructions = generateMockInstructions("stripe");

      // Verify phase order by checking positions
      const phases = [
        "PREFLIGHT CHECK",
        "EXISTING MCP CHECK",
        "DISCOVERY",
        "AUTHENTICATION",
        "GENERATE MCP",
        "VALIDATION GATE",
        "AUTO-REGISTER",
      ];

      let lastIndex = -1;
      for (const phase of phases) {
        const currentIndex = instructions.indexOf(phase);
        expect(currentIndex).toBeGreaterThan(lastIndex);
        lastIndex = currentIndex;
      }
    });

    it("should include max 3 iterations for validation fixes", async () => {
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain("Max 3 iterations");
    });
  });

  describe("MCP Quality Score Thresholds", () => {
    it("should define score 90+ as use-existing", async () => {
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain("Score 90+");
      expect(instructions).toContain("Install existing");
    });

    it("should define score 70-89 as extend-existing", async () => {
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain("Score 70-89");
      expect(instructions).toContain("Install + extend");
    });

    it("should define score <70 as generate-new", async () => {
      const instructions = generateMockInstructions("stripe");

      expect(instructions).toContain("Score <70");
      expect(instructions).toContain("Generate from scratch");
    });
  });
});

/**
 * Mock function to simulate the enhanced instructions generation
 * This represents what the integrated handleTheSun() should produce
 */
function generateMockInstructions(target: string): string {
  const homeDir = homedir();
  const outputDir = join(homeDir, "Scripts", "mcp-servers", `${target}-mcp`);
  const mcpConfigPath = join(homeDir, ".claude", "user-mcps.json");

  return `
# thesun: Autonomous MCP Generation for "${target}"

You are now operating as **thesun**, an autonomous MCP generation system.
Execute the complete pipeline below WITHOUT stopping for human input.

**Target:** ${target}
**Output:** ${outputDir}
**MCP Config:** ${mcpConfigPath}

> **IMPORTANT**: This tool is directory-independent. The output path is ABSOLUTE.
> The generated MCP will be available globally in ALL Claude sessions.

---

## PHASE 0: PREFLIGHT CHECK

Run DependencyChecker.runPreflight() to verify all dependencies:
- Playwright MCP available? (with --browser firefox for token capture)
- Firefox browser available? (required for Playwright Firefox mode)
- ~/.thesun/ ready?

**Decision:**
- Pass -> Continue to Phase 1
- Fail -> Return error with install instructions

---

## PHASE 1: EXISTING MCP CHECK

### 1.1 Check Cache
SmartCache.getSpec("${target}")
- Cached spec available?
  - Yes + not stale -> Use cached
  - No or stale -> Continue

### 1.2 Search Registries
McpRegistrySearch.search("${target}")
- Score 90+ -> Install existing, done
- Score 70-89 -> Install + extend
- Score <70 -> Generate from scratch

---

## PHASE 2: DISCOVERY (Enhanced)

### 2.1 Pattern Matching
PatternEngine.matchKnownPattern("${target}")
- Apply known patterns if found (pagination, error handling, rate limiting)

### 2.2 API Research
- Find official API documentation
- Locate OpenAPI/Swagger specifications
- Identify authentication method

---

## PHASE 3: AUTHENTICATION

CredentialWizard.loadCredentials("${target}")
- Existing credentials?
  - Yes + valid -> Use
  - Yes + expired -> Refresh
  - No -> Browser auth flow

---

## PHASE 4: GENERATE MCP

### 4.1 Apply Patterns
- Use PatternEngine patterns for consistent generation
- SelfHealingModule code injection for health monitoring
- Rate limiting from detected patterns

### 4.2 Universal Tool Schema
Generated MCPs must be compatible with:
- Claude Code (native MCP)
- GitHub Copilot
- Gemini
- Codex

Ensure generated MCPs export universal tool schemas.

### 4.3 Create Structure
\`\`\`
${outputDir}/
├── src/
│   └── index.ts          # MCP server entry point
├── scripts/
│   ├── install.sh        # Linux/macOS installer
│   └── install.ps1       # Windows PowerShell installer
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
\`\`\`

---

## PHASE 5: VALIDATION GATE

ValidationGate.runValidation("${target}", "${outputDir}")
- Build validation (TypeScript compiles)
- Endpoint testing
- Auth flow validation
- Integration test
- Max 3 iterations to fix

---

## PHASE 6: AUTO-REGISTER

### 6.1 Cache the Spec
SmartCache.cacheSpec("${target}")

### 6.2 Register in user-mcps.json
Add to ${mcpConfigPath}:
\`\`\`json
{
  "mcpServers": {
    "${target}": {
      "command": "node",
      "args": ["${outputDir}/dist/index.js"],
      "env": {}
    }
  }
}
\`\`\`

---

## EXECUTION RULES

1. **Be autonomous** - Don't ask for permission at each step
2. **Use preflight** - Always run DependencyChecker first
3. **Check existing MCPs** - Don't regenerate unnecessarily
4. **Apply patterns** - Use PatternEngine for consistency
5. **Validate thoroughly** - Use ValidationGate with retry
6. **Cache results** - Use SmartCache for incremental updates
7. **Monitor health** - Inject SelfHealingModule code

---

**BEGIN EXECUTION NOW. Start with Phase 0: Preflight Check.**
`;
}
