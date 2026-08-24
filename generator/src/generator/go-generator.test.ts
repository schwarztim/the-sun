import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  generateGoServer,
  endpointsFromDiscovery,
  GoServerConfig,
} from "./go-generator.js";

const baseConfig: GoServerConfig = {
  name: "shodan",
  baseUrl: "https://api.shodan.io",
  authScheme: "api_key",
  apiKeyQueryParam: "key",
  endpoints: [
    { method: "GET", path: "/api-info", operationId: "apiInfo", description: "info" },
    {
      method: "GET",
      path: "/shodan/host/{ip}",
      operationId: "host",
      description: "host lookup",
      pathParams: ["ip"],
      queryParams: [{ name: "minify", required: false }],
    },
  ],
};

describe("generateGoServer", () => {
  it("emits the expected file set", () => {
    const { files } = generateGoServer(baseConfig);
    expect(Object.keys(files).sort()).toEqual(
      [
        ".dockerignore",
        ".env.example",
        "Dockerfile",
        "README.md",
        "coverage.json",
        "gateway-manifest.json",
        "go.mod",
        "lab.launch.json",
        "main.go",
      ].sort(),
    );
  });

  it("is streamable-http ONLY — no stdio/SSE transport wiring", () => {
    const { files } = generateGoServer(baseConfig);
    expect(files["main.go"]).toContain("NewStreamableHTTPHandler");
    expect(files["main.go"]).toContain("Stateless: true");
    // No actual stdio/SSE transport constructors (the doc-comment may say the
    // words "never stdio, never SSE" — that's the contract, not a violation).
    expect(files["main.go"]).not.toMatch(/NewStdioTransport|StdioTransport|NewSSEHandler|NewSSEServerTransport/);
  });

  it("requires MCP_PORT with no default", () => {
    const { files } = generateGoServer(baseConfig);
    expect(files["main.go"]).toContain('port := os.Getenv("MCP_PORT")');
    expect(files["main.go"]).toContain("MCP_PORT is required and has no default");
  });

  it("exposes /healthz and mounts /mcp", () => {
    const { files } = generateGoServer(baseConfig);
    expect(files["main.go"]).toContain('mux.HandleFunc("/healthz"');
    expect(files["main.go"]).toContain('mux.Handle("/mcp"');
  });

  it("registers one tool per endpoint with a service-prefixed name", () => {
    const { files } = generateGoServer(baseConfig);
    expect(files["main.go"]).toContain('Name:        "shodan_api_info"');
    expect(files["main.go"]).toContain('Name:        "shodan_host"');
  });

  it("marks required path params required and optional query params omitempty", () => {
    const { files } = generateGoServer(baseConfig);
    // Path param `ip` is required (no omitempty).
    expect(files["main.go"]).toMatch(/Ip string `json:"ip" /);
    // Optional query param `minify` is omitempty (not required in the schema).
    expect(files["main.go"]).toContain('json:"minify,omitempty"');
  });

  it("never hardcodes a credential and reads it from the env at runtime", () => {
    const { files } = generateGoServer(baseConfig);
    expect(files["main.go"]).toContain('os.Getenv(envKey)');
    expect(files["main.go"]).toContain('"SHODAN_API_KEY"');
    // Scrubbing/redaction of the credential from errors.
    expect(files["main.go"]).toContain("func redact(");
    expect(files["main.go"]).toContain("func scrub(");
  });

  it("Dockerfile is a multi-stage static → distroless build", () => {
    const { files } = generateGoServer(baseConfig);
    expect(files["Dockerfile"]).toContain("CGO_ENABLED=0");
    expect(files["Dockerfile"]).toContain("FROM gcr.io/distroless/static:nonroot");
    expect(files["Dockerfile"]).toContain("EXPOSE");
  });

  it("go.mod requires the go-sdk", () => {
    const { files } = generateGoServer(baseConfig);
    expect(files["go.mod"]).toContain("module shodan-mcp");
    expect(files["go.mod"]).toContain("github.com/modelcontextprotocol/go-sdk");
  });

  it("wires uTLS browser camouflage: go.mod deps + ClientHello + User-Agent", () => {
    const { files } = generateGoServer(baseConfig);
    // go.mod pulls in uTLS and the http2 package the ClientHelloID/ALPN
    // handshake needs.
    expect(files["go.mod"]).toContain("github.com/refraction-networking/utls");
    expect(files["go.mod"]).toContain("golang.org/x/net");
    // main.go performs a real uTLS ClientHello handshake (not just imports
    // the package) and negotiates HTTP/2 via golang.org/x/net/http2.
    expect(files["main.go"]).toContain('utls "github.com/refraction-networking/utls"');
    expect(files["main.go"]).toContain('"golang.org/x/net/http2"');
    expect(files["main.go"]).toContain("utls.UClient(");
    expect(files["main.go"]).toContain("HandshakeContext(");
    expect(files["main.go"]).toContain("t2.NewClientConn(");
    // The profile is read from <THESUN_HOME>/camouflage.json (fleetd's
    // internal/camouflage contract), with a safe Chrome-131 default.
    expect(files["main.go"]).toContain('"camouflage.json"');
    expect(files["main.go"]).toContain("func thesunHome()");
    expect(files["main.go"]).toContain("utls.HelloChrome_131");
    // The outbound call to apiBase actually sends the resolved User-Agent —
    // and does so through camouflageClient, not the plain httpClient used by
    // the local Hermes broker / OAuth helpers.
    expect(files["main.go"]).toContain('req.Header.Set("User-Agent", camouflageUserAgent)');
    expect(files["main.go"]).toContain("camouflageClient.Do(req)");
  });

  it("rejects a non-https base url", () => {
    expect(() =>
      generateGoServer({ ...baseConfig, baseUrl: "http://insecure.example" }),
    ).toThrow(/https/);
  });

  it("rejects an empty endpoint list", () => {
    expect(() => generateGoServer({ ...baseConfig, endpoints: [] })).toThrow(/endpoint/);
  });

  it("rejects an empty / missing base url (GEN-3)", () => {
    expect(() => generateGoServer({ ...baseConfig, baseUrl: "" })).toThrow(/baseUrl/);
    expect(() =>
      generateGoServer({ ...(baseConfig as GoServerConfig), baseUrl: undefined as unknown as string }),
    ).toThrow(/baseUrl/);
  });

  it("emits reactive 429/503 Retry-After backoff in the request path (GEN-1)", () => {
    const { files } = generateGoServer(baseConfig);
    const main = files["main.go"];
    // Reactive retry on both throttle status codes.
    expect(main).toContain("resp.StatusCode == 429 || resp.StatusCode == 503");
    // Reads the Retry-After header to decide the wait.
    expect(main).toContain('resp.Header.Get("Retry-After")');
    // Bounded retry count and a capped wait.
    expect(main).toContain("reactiveMaxRetries = 3");
    expect(main).toContain("reactiveMaxWait = 30 * time.Second");
    expect(main).toContain("attempt < reactiveMaxRetries");
    // The Retry-After parser handles both delta-seconds and HTTP-date, with an
    // exponential-backoff fallback, all clamped to the cap.
    expect(main).toContain("func retryAfterDelay(");
    expect(main).toContain("strconv.Atoi(header)");
    expect(main).toContain("http.ParseTime(header)");
    expect(main).toContain("1<<uint(attempt)");
    // Dependency-free: standard net/http + time only (no third-party retry lib).
    expect(main).toContain('"strconv"');
  });
});

describe("generateGoServer — gateway-manifest.json (isaac-router-manifest/v1)", () => {
  // Mirrors the shape of gateway/manifests/shodan-go.json — a GET-only
  // service — plus a WRITE-verb-shaped POST endpoint so both branches of the
  // GET-vs-POST http_method/safety_class derivation are exercised in one
  // config, catching the exact shodan_dns_resolve RISKY_AS_READ class of bug
  // (a GET tool whose name/verb would otherwise be misclassified) as well as
  // its inverse (a POST tool correctly classed WRITE).
  const config: GoServerConfig = {
    name: "shodan",
    baseUrl: "https://api.shodan.io",
    authScheme: "api_key",
    apiKeyQueryParam: "key",
    endpoints: [
      {
        method: "GET",
        path: "/dns/resolve",
        operationId: "dnsResolve",
        description: "resolve hostnames to IPs",
      },
      {
        method: "POST",
        path: "/scan",
        operationId: "scan",
        description: "submit a scan request",
      },
    ],
  };

  it("emits isaac-router-manifest/v1 with a capability per endpoint plus the help tool", () => {
    const { files } = generateGoServer(config);
    const manifest = JSON.parse(files["gateway-manifest.json"]);
    expect(manifest.manifest).toBe("isaac-router-manifest/v1");
    expect(manifest.backend).toBe("shodan-go");
    expect(manifest.capabilities).toHaveLength(3); // 2 endpoints + help
  });

  it("derives http_method GET and safety_class READ for a GET endpoint, even one shaped like a write verb", () => {
    const { files } = generateGoServer(config);
    const manifest = JSON.parse(files["gateway-manifest.json"]);
    const cap = manifest.capabilities.find((c: { tool: string }) => c.tool === "shodan_dns_resolve");
    expect(cap).toBeDefined();
    expect(cap.http_method).toBe("GET");
    expect(cap.safety_class).toBe("READ");
    expect(cap.locality).toBe("remote");
    expect(cap.tags).toEqual(["shodan", "get"]);
  });

  it("derives http_method POST and safety_class WRITE for a POST endpoint", () => {
    const { files } = generateGoServer(config);
    const manifest = JSON.parse(files["gateway-manifest.json"]);
    const cap = manifest.capabilities.find((c: { tool: string }) => c.tool === "shodan_scan");
    expect(cap).toBeDefined();
    expect(cap.http_method).toBe("POST");
    expect(cap.safety_class).toBe("WRITE");
    expect(cap.tags).toEqual(["shodan", "post"]);
  });

  it("classifies the synthetic help tool as local/READ with no http_method", () => {
    const { files } = generateGoServer(config);
    const manifest = JSON.parse(files["gateway-manifest.json"]);
    const help = manifest.capabilities.find((c: { tool: string }) => c.tool === "shodan-mcp_help");
    expect(help).toBeDefined();
    expect(help.safety_class).toBe("READ");
    expect(help.locality).toBe("local");
    expect(help.http_method).toBeUndefined();
  });
});

describe("generateGoServer — cookie-session genericAuthFallback (easy auth path)", () => {
  const servicenowConfig: GoServerConfig = {
    name: "servicenow",
    baseUrl: "https://example.service-now.com",
    authScheme: "cookie-session",
    genericAuthFallback: true,
    endpoints: [
      {
        method: "GET",
        path: "/api/now/table/incident",
        operationId: "listIncident",
        description: "list incidents",
        queryParams: [{ name: "sysparm_limit", required: false }],
      },
    ],
  };

  it("emits the generic Basic/OAuth2 env contract alongside the Hermes SSO fallback", () => {
    const { files } = generateGoServer(servicenowConfig);
    const main = files["main.go"];
    // Generic easy-path env vars.
    expect(main).toContain("SERVICENOW_INSTANCE_URL");
    expect(main).toContain("SERVICENOW_BASIC_AUTH");
    expect(main).toContain("SERVICENOW_USERNAME");
    expect(main).toContain("SERVICENOW_PASSWORD");
    expect(main).toContain("SERVICENOW_CLIENT_ID");
    expect(main).toContain("SERVICENOW_CLIENT_SECRET");
    expect(main).toContain("SERVICENOW_TOKEN_URL");
    // Selection logic + helpers.
    expect(main).toContain("func genericAuthConfigured() bool");
    expect(main).toContain("func instanceBaseURL() string");
    expect(main).toContain("func resolveOAuthToken(ctx context.Context) string");
    expect(main).toContain('req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(key)))');
    expect(main).toContain('req.Header.Set("Authorization", "Bearer "+key)');
    // Advanced SSO fallback stays intact and unchanged.
    expect(main).toContain("hermesUserToken");
    expect(main).toContain('req.Header.Set("Cookie", key)');
    expect(main).toContain('"encoding/base64"');
  });

  it("does NOT alter servers using cookie-session WITHOUT genericAuthFallback (e.g. akamai-wsa)", () => {
    const { files } = generateGoServer({ ...servicenowConfig, genericAuthFallback: false });
    const main = files["main.go"];
    expect(main).not.toContain("SERVICENOW_BASIC_AUTH");
    expect(main).not.toContain("genericAuthConfigured");
    expect(main).not.toContain('"encoding/base64"');
    expect(main).toContain("no Hermes-managed session available");
  });

  it(
    "compiles with `go build` (module cache warm from prior generations)",
    () => {
      const { files } = generateGoServer(servicenowConfig);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thesun-servicenow-parity-"));
      try {
        for (const [rel, content] of Object.entries(files)) {
          const full = path.join(dir, rel);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, content);
        }
        execFileSync("go", ["build", "-o", path.join(dir, "servicenow-mcp"), "."], {
          cwd: dir,
          stdio: "pipe",
          // -mod=mod lets `go build` fill in go.sum from the module cache/proxy
          // for a go.mod that was never `go mod tidy`'d (these files are
          // rendered as static strings, not built via the go toolchain).
          // Without it, Go 1.16+'s default -mod=readonly fails closed on
          // every dependency with "missing go.sum entry" — a
          // generation-environment gap, not a defect in the generated
          // server itself.
          env: { ...process.env, GOFLAGS: "-mod=mod" },
        });
        expect(fs.existsSync(path.join(dir, "servicenow-mcp"))).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    // Resolving new modules (uTLS + golang.org/x/net) over the network on a
    // cold cache can take a few seconds — well past vitest's 5s default.
    30_000,
  );
});

describe("endpointsFromDiscovery", () => {
  it("splits path and query params from DiscoveredEndpoint shape", () => {
    const out = endpointsFromDiscovery([
      {
        method: "GET",
        path: "/host/{ip}",
        operationId: "host",
        parameters: [
          { name: "ip", in: "path", required: true },
          { name: "minify", in: "query", required: false },
        ],
      },
    ]);
    expect(out[0].pathParams).toEqual(["ip"]);
    expect(out[0].queryParams).toEqual([{ name: "minify", required: false, description: undefined }]);
  });
});
