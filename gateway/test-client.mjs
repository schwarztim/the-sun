import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://localhost:3100/sse"));
const client = new Client({ name: "test-client", version: "1.0.0" });

try {
  await client.connect(transport);
  console.log("✅ Connected to gateway via SSE");

  // List tools
  const { tools } = await client.listTools();
  console.log(`\n📦 Total tools: ${tools.length}`);
  
  // Show first 20 tools
  console.log("\nFirst 20 tools:");
  tools.slice(0, 20).forEach(t => console.log(`  - ${t.name}`));
  
  // Count by namespace
  const byNs = {};
  tools.forEach(t => {
    const ns = t.name.split('_')[0];
    byNs[ns] = (byNs[ns] || 0) + 1;
  });
  console.log("\nTools by namespace prefix:");
  Object.entries(byNs).sort((a,b) => b[1]-a[1]).forEach(([ns, count]) => {
    console.log(`  ${ns}: ${count}`);
  });

  // Test calling CrowdStrike host_counts (simple, no params needed)
  console.log("\n🔧 Testing tool call: crowdstrike_host_counts...");
  try {
    const result = await client.callTool({ name: "crowdstrike_host_counts", arguments: {} });
    console.log("✅ Tool call succeeded!");
    console.log("Result:", JSON.stringify(result.content?.[0]?.text?.substring(0, 200) || result));
  } catch (e) {
    console.log("❌ Tool call failed:", e.message);
  }

  await client.close();
  console.log("\n✅ Test complete!");
} catch (e) {
  console.error("Error:", e.message);
  process.exit(1);
}
