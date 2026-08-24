/**
 * MCP Registry Search Tests
 *
 * Tests for searching existing MCPs across multiple registries
 * before generating new ones.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import nock from "nock";
import { McpRegistrySearch } from "./mcp-registry-search.js";
import type { ExistingMcp, McpQualityScore } from "../types/index.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// Mock the logger to reduce noise in tests
vi.mock("../observability/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("McpRegistrySearch", () => {
  let searcher: McpRegistrySearch;
  let tempDir: string;
  let userMcpsPath: string;

  beforeEach(async () => {
    // Create temp directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-search-test-"));
    userMcpsPath = path.join(tempDir, "user-mcps.json");

    searcher = new McpRegistrySearch({
      userMcpsPath,
      timeout: 5000,
    });

    // Clean up any leftover nock interceptors
    nock.cleanAll();
  });

  afterEach(async () => {
    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
    nock.cleanAll();
  });

  describe("searchUserInstalled", () => {
    it("finds MCP in user-mcps.json by exact name", async () => {
      // Setup user-mcps.json with test data
      const userMcps = {
        mcpServers: {
          "slack-mcp": {
            command: "node",
            args: ["/path/to/slack-mcp/index.js"],
            description: "Slack MCP server",
          },
          "jira-mcp": {
            command: "npx",
            args: ["-y", "@acme/jira-mcp"],
            description: "Jira integration",
          },
        },
      };
      await fs.writeFile(userMcpsPath, JSON.stringify(userMcps));

      const results = await searcher.searchUserInstalled("slack");

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("slack-mcp");
      expect(results[0].source).toBe("user-installed");
    });

    it("finds MCP by partial name match", async () => {
      const userMcps = {
        mcpServers: {
          "atlassian-jira-mcp": {
            command: "node",
            args: ["/path/to/jira/index.js"],
          },
          "atlassian-confluence-mcp": {
            command: "node",
            args: ["/path/to/confluence/index.js"],
          },
        },
      };
      await fs.writeFile(userMcpsPath, JSON.stringify(userMcps));

      const results = await searcher.searchUserInstalled("jira");

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("atlassian-jira-mcp");
    });

    it("returns empty array when no matches found", async () => {
      const userMcps = {
        mcpServers: {
          "github-mcp": {
            command: "node",
            args: [],
          },
        },
      };
      await fs.writeFile(userMcpsPath, JSON.stringify(userMcps));

      const results = await searcher.searchUserInstalled("slack");

      expect(results).toHaveLength(0);
    });

    it("returns empty array when user-mcps.json does not exist", async () => {
      const results = await searcher.searchUserInstalled("anything");

      expect(results).toHaveLength(0);
    });

    it("handles malformed user-mcps.json gracefully", async () => {
      await fs.writeFile(userMcpsPath, "not valid json");

      const results = await searcher.searchUserInstalled("test");

      expect(results).toHaveLength(0);
    });
  });

  describe("searchNpm", () => {
    it("finds MCP packages from npm registry", async () => {
      const npmResponse = {
        objects: [
          {
            package: {
              name: "@modelcontextprotocol/server-slack",
              version: "1.2.0",
              description: "MCP server for Slack",
              date: "2025-01-15T10:00:00Z",
            },
            score: { detail: { popularity: 0.8 } },
          },
          {
            package: {
              name: "slack-mcp-server",
              version: "0.5.0",
              description: "Another Slack MCP",
              date: "2024-12-01T10:00:00Z",
            },
            score: { detail: { popularity: 0.3 } },
          },
        ],
      };

      nock("https://registry.npmjs.org")
        .get("/-/v1/search")
        .query(
          (query) =>
            query.text?.includes("mcp") && query.text?.includes("slack"),
        )
        .reply(200, npmResponse);

      const results = await searcher.searchNpm("slack");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].source).toBe("npm");
      expect(results[0].name).toBe("@modelcontextprotocol/server-slack");
    });

    it("returns empty array on npm error", async () => {
      nock("https://registry.npmjs.org")
        .get("/-/v1/search")
        .query(true)
        .reply(500, "Internal Server Error");

      const results = await searcher.searchNpm("slack");

      expect(results).toHaveLength(0);
    });

    it("handles npm timeout gracefully", async () => {
      // Create a searcher with shorter timeout for this test
      const shortTimeoutSearcher = new McpRegistrySearch({
        userMcpsPath,
        timeout: 100, // 100ms timeout
      });

      nock("https://registry.npmjs.org")
        .get("/-/v1/search")
        .query(true)
        .delayConnection(500) // 500ms delay, longer than 100ms timeout
        .reply(200, {});

      const results = await shortTimeoutSearcher.searchNpm("slack");

      expect(results).toHaveLength(0);
    });
  });

  describe("searchGitHub", () => {
    it("finds MCP repositories from GitHub", async () => {
      const githubResponse = {
        items: [
          {
            full_name: "modelcontextprotocol/servers",
            html_url: "https://github.com/modelcontextprotocol/servers",
            description: "MCP servers collection",
            stargazers_count: 5000,
            updated_at: "2025-01-20T10:00:00Z",
          },
          {
            full_name: "acme/slack-mcp",
            html_url: "https://github.com/acme/slack-mcp",
            description: "Slack MCP server",
            stargazers_count: 100,
            updated_at: "2025-01-10T10:00:00Z",
          },
        ],
      };

      nock("https://api.github.com")
        .get("/search/repositories")
        .query(true)
        .reply(200, githubResponse);

      const results = await searcher.searchGitHub("slack");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].source).toBe("github");
    });

    it("returns empty array on GitHub rate limit", async () => {
      nock("https://api.github.com")
        .get("/search/repositories")
        .query(true)
        .reply(403, { message: "Rate limit exceeded" });

      const results = await searcher.searchGitHub("slack");

      expect(results).toHaveLength(0);
    });
  });

  describe("searchSmithery", () => {
    it("finds MCPs from Smithery registry", async () => {
      const smitheryResponse = {
        servers: [
          {
            name: "slack",
            qualifiedName: "@smithery/slack",
            description: "Slack integration MCP",
            version: "1.0.0",
            homepage: "https://smithery.ai/server/@smithery/slack",
          },
        ],
      };

      nock("https://registry.smithery.ai")
        .get("/api/v1/servers")
        .query(true)
        .reply(200, smitheryResponse);

      const results = await searcher.searchSmithery("slack");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].source).toBe("smithery");
    });

    it("returns empty array when Smithery is unavailable", async () => {
      nock("https://registry.smithery.ai")
        .get("/api/v1/servers")
        .query(true)
        .reply(503, "Service Unavailable");

      const results = await searcher.searchSmithery("slack");

      expect(results).toHaveLength(0);
    });
  });

  describe("calculateQualityScore", () => {
    it("calculates high score for well-maintained MCP", () => {
      const inputs = {
        coverage: 95,
        lastCommitDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 1 week ago
        hasVulnerabilities: false,
        supportsRequiredAuth: true,
        issueResponseTimeDays: 2,
      };

      const score = searcher.calculateQualityScore(inputs);

      expect(score.overall).toBeGreaterThanOrEqual(90);
      expect(score.coverage).toBe(95);
      expect(score.maintenance).toBeGreaterThanOrEqual(80);
      expect(score.security).toBe(100);
      expect(score.authSupport).toBe(100);
    });

    it("calculates low score for outdated MCP", () => {
      const inputs = {
        coverage: 50,
        lastCommitDate: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), // 1 year ago
        hasVulnerabilities: true,
        supportsRequiredAuth: false,
        issueResponseTimeDays: 30,
      };

      const score = searcher.calculateQualityScore(inputs);

      expect(score.overall).toBeLessThan(70);
      expect(score.coverage).toBe(50);
      expect(score.maintenance).toBeLessThan(50);
      expect(score.security).toBeLessThan(50);
      expect(score.authSupport).toBe(0);
    });

    it("weights components correctly (30% coverage, 25% maintenance, 25% security, 20% auth)", () => {
      const inputs = {
        coverage: 100, // 30 points
        lastCommitDate: new Date(), // 25 points (recent)
        hasVulnerabilities: false, // 25 points
        supportsRequiredAuth: true, // 20 points
        issueResponseTimeDays: 1,
      };

      const score = searcher.calculateQualityScore(inputs);

      // Perfect score should be 100
      expect(score.overall).toBe(100);
    });

    it("handles missing optional inputs gracefully", () => {
      const inputs = {
        coverage: 80,
      };

      const score = searcher.calculateQualityScore(inputs);

      expect(score.coverage).toBe(80);
      expect(score.overall).toBeGreaterThan(0);
    });
  });

  describe("getRecommendation", () => {
    it("returns use-existing for score 90+", () => {
      const recommendation = searcher.getRecommendation(95);
      expect(recommendation).toBe("use-existing");
    });

    it("returns use-existing for score exactly 90", () => {
      const recommendation = searcher.getRecommendation(90);
      expect(recommendation).toBe("use-existing");
    });

    it("returns extend-existing for score 70-89", () => {
      const recommendation = searcher.getRecommendation(85);
      expect(recommendation).toBe("extend-existing");
    });

    it("returns extend-existing for score exactly 70", () => {
      const recommendation = searcher.getRecommendation(70);
      expect(recommendation).toBe("extend-existing");
    });

    it("returns generate-new for score below 70", () => {
      const recommendation = searcher.getRecommendation(65);
      expect(recommendation).toBe("generate-new");
    });

    it("returns generate-new for score 0", () => {
      const recommendation = searcher.getRecommendation(0);
      expect(recommendation).toBe("generate-new");
    });
  });

  describe("search (integration)", () => {
    it("searches all sources and returns aggregated results", async () => {
      // Setup user MCPs
      const userMcps = {
        mcpServers: {
          "slack-mcp": {
            command: "node",
            args: ["/path/to/slack-mcp"],
          },
        },
      };
      await fs.writeFile(userMcpsPath, JSON.stringify(userMcps));

      // Mock npm
      nock("https://registry.npmjs.org")
        .get("/-/v1/search")
        .query(true)
        .reply(200, { objects: [] });

      // Mock GitHub
      nock("https://api.github.com")
        .get("/search/repositories")
        .query(true)
        .reply(200, { items: [] });

      // Mock Smithery
      nock("https://registry.smithery.ai")
        .get("/api/v1/servers")
        .query(true)
        .reply(200, { servers: [] });

      const result = await searcher.search("slack");

      expect(result.target).toBe("slack");
      expect(result.searched).toContain("user-installed");
      expect(result.searched).toContain("npm");
      expect(result.searched).toContain("github");
      expect(result.searched).toContain("smithery");
      expect(result.found.length).toBeGreaterThanOrEqual(1); // At least user-installed
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it("returns generate-new when no MCPs found", async () => {
      // No user MCPs file
      // Mock empty responses
      nock("https://registry.npmjs.org")
        .get("/-/v1/search")
        .query(true)
        .reply(200, { objects: [] });

      nock("https://api.github.com")
        .get("/search/repositories")
        .query(true)
        .reply(200, { items: [] });

      nock("https://registry.smithery.ai")
        .get("/api/v1/servers")
        .query(true)
        .reply(200, { servers: [] });

      const result = await searcher.search("obscure-api");

      expect(result.found).toHaveLength(0);
      expect(result.bestMatch).toBeUndefined();
      expect(result.recommendation).toBe("generate-new");
    });

    it("selects best match based on quality score", async () => {
      // Setup multiple sources with different quality
      const userMcps = {
        mcpServers: {
          "slack-old": {
            command: "node",
            args: ["/old/slack"],
            description: "Old Slack MCP",
          },
        },
      };
      await fs.writeFile(userMcpsPath, JSON.stringify(userMcps));

      nock("https://registry.npmjs.org")
        .get("/-/v1/search")
        .query(true)
        .reply(200, {
          objects: [
            {
              package: {
                name: "@mcp/slack-server",
                version: "2.0.0",
                description: "Official Slack MCP",
                date: new Date().toISOString(),
              },
              score: { detail: { popularity: 0.9 } },
            },
          ],
        });

      nock("https://api.github.com")
        .get("/search/repositories")
        .query(true)
        .reply(200, { items: [] });

      nock("https://registry.smithery.ai")
        .get("/api/v1/servers")
        .query(true)
        .reply(200, { servers: [] });

      const result = await searcher.search("slack");

      expect(result.found.length).toBeGreaterThanOrEqual(2);
      // Best match should have the highest score
      if (result.bestMatch) {
        for (const mcp of result.found) {
          if (mcp.score && result.bestMatch.score) {
            expect(result.bestMatch.score.overall).toBeGreaterThanOrEqual(
              mcp.score.overall,
            );
          }
        }
      }
    });

    it("continues searching even if one source fails", async () => {
      // User MCPs available
      const userMcps = {
        mcpServers: {
          "slack-mcp": {
            command: "node",
            args: [],
          },
        },
      };
      await fs.writeFile(userMcpsPath, JSON.stringify(userMcps));

      // npm fails
      nock("https://registry.npmjs.org")
        .get("/-/v1/search")
        .query(true)
        .reply(500);

      // GitHub fails
      nock("https://api.github.com")
        .get("/search/repositories")
        .query(true)
        .reply(403);

      // Smithery succeeds
      nock("https://registry.smithery.ai")
        .get("/api/v1/servers")
        .query(true)
        .reply(200, { servers: [] });

      const result = await searcher.search("slack");

      // Should still have results from user-installed
      expect(result.found.length).toBeGreaterThanOrEqual(1);
      expect(result.searched).toContain("user-installed");
      expect(result.searched).toContain("smithery");
    });
  });
});
