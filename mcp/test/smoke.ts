// End-to-end check: spawns the built server over stdio (like Claude Desktop would),
// discovers its tools through Mastra's MCPClient, and exercises each one.
// Uses a throwaway database so your real data is untouched.
import { MCPClient } from "@mastra/mcp";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "ts-smoke-"));
const mcp = new MCPClient({
  id: "smoke",
  servers: {
    steward: {
      command: process.execPath,
      args: ["dist/index.js"],
      env: { TIME_STEWARD_DB: join(dir, "test.db") },
    },
  },
});

const call = async (tools: Record<string, any>, name: string, input: object) => {
  const out = await tools[`steward_${name}`].execute(input, {});
  // MCP tool results arrive as content blocks; unwrap the JSON payload.
  const payload = out?.structuredContent ?? out;
  const text = payload?.content?.[0]?.text;
  return text ? JSON.parse(text) : payload;
};

try {
  const tools = await mcp.listTools();
  const names = Object.keys(tools).sort();
  console.log("tools:", names.join(", "));
  assert.equal(names.length, 7);

  await call(tools, "set_goals", {
    goals: [
      { category: "sleep", target_minutes_per_week: 3570, kind: "at_least", note: "8.5h/night" },
      { category: "Side Project", target_minutes_per_week: 300, kind: "at_least" },
      { category: "tv", target_minutes_per_week: 300, kind: "at_most" },
    ],
  });
  const goals = await call(tools, "get_goals", {});
  assert.equal(goals.goals.length, 3);
  assert.ok(goals.goals.some((g: any) => g.category === "side_project"), "category normalized");

  await call(tools, "log_time", { category: "sleep", minutes: 480 });
  await call(tools, "log_time", { category: "TV", minutes: 400, note: "movie night" });
  const extra = await call(tools, "log_time", { category: "running", minutes: 30 });
  assert.ok(extra.warning, "warns on category without a goal");

  const bad = await call(tools, "log_time", { category: "x", minutes: 15 });
  const logs = await call(tools, "list_logs", {});
  assert.equal(logs.entries.length, 4);
  assert.equal((await call(tools, "delete_log", { id: bad.id })).deleted, true);

  const summary = await call(tools, "week_summary", {});
  console.log(JSON.stringify(summary, null, 2));
  const tv = summary.goals.find((g: any) => g.category === "tv");
  assert.equal(tv.status, "over_cap");
  assert.deepEqual(summary.untracked, [{ category: "running", minutes: 30 }]);

  // Input validation is enforced at the server.
  let rejected = false;
  try {
    const r = await call(tools, "log_time", { category: "sleep", minutes: -5 });
    rejected = !!(r?.error || r?.isError);
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "negative minutes rejected");

  console.log("\nAll checks passed.");
} finally {
  await mcp.disconnect();
  rmSync(dir, { recursive: true, force: true });
}
