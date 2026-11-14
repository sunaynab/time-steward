// Wiring test: runs the real agent, real MCP server and real memory, with a scripted
// mock model in place of Claude (no API key needed). Checks that:
//  1. the agent discovers the time-log tools over MCP and its tool calls reach SQLite,
//  2. calendar writes suspend for approval, and decline/approve behave correctly.
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { MockLanguageModelV3 } from "ai/test";

const tmp = mkdtempSync(join(tmpdir(), "ts-agent-"));
process.env.TIME_STEWARD_DB = join(tmp, "steward.db");
process.env.HOME = tmp; // keep agent memory out of the real ~/.time-steward
delete process.env.GOOGLE_OAUTH_CREDENTIALS;

const { agent } = await import("../src/agent.js");
const { mcp, calendarApproval } = await import("../src/mcp.js");
const { MCPClient } = await import("@mastra/mcp");

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const toolCall = (id: string, toolName: string, input: object) => ({
  content: [{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: "tool_use" },
  usage,
  warnings: [],
});
const reply = (text: string) => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: "end_turn" },
  usage,
  warnings: [],
});

/** A fake model that plays back one scripted step per call, and records the tools it was offered. */
function scripted(steps: any[]) {
  const seenTools: string[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (opts: any) => {
      seenTools.push((opts.tools ?? []).map((t: any) => t.name));
      const step = steps.shift();
      if (!step) throw new Error("model called more times than scripted");
      return step;
    },
  });
  return { model, seenTools };
}

const memory = { resource: "test", thread: "wiring" };
const here = dirname(fileURLToPath(import.meta.url));
const calLog = join(tmp, "calendar-writes.jsonl");
const calendar = new MCPClient({
  id: "fake-cal",
  servers: {
    calendar: {
      command: process.execPath,
      args: ["--import", "tsx", join(here, "fake-calendar.ts")],
      env: { FAKE_CALENDAR_LOG: calLog, PATH: process.env.PATH! },
      requireToolApproval: calendarApproval,
    },
  },
});

try {
  // 1. Time-log tools: set a goal, log a run, then read the summary.
  const s1 = scripted([
    toolCall("c1", "steward_set_goals", { goals: [{ category: "exercise", target_minutes_per_week: 90 }] }),
    toolCall("c2", "steward_log_time", { category: "exercise", minutes: 30, note: "run" }),
    toolCall("c3", "steward_week_summary", {}),
    reply("Logged your 30-minute run."),
  ]);
  const r1: any = await agent.generate("I ran for 30 minutes today", { model: s1.model as any, memory });
  assert.equal(r1.text, "Logged your 30-minute run.");
  for (const t of ["steward_set_goals", "steward_log_time", "steward_week_summary"]) {
    assert.ok(s1.seenTools[0].includes(t), `model was offered ${t}`);
  }
  const results = r1.steps.flatMap((s: any) => s.toolResults ?? []);
  const summary = JSON.stringify(results.at(-1));
  assert.match(summary, /actual_minutes[\\"]*:30/, "summary reflects the logged run");
  console.log("✓ agent → MCP → SQLite round trip");

  // 2. Calendar write is suspended; declining must not write anything.
  const calTools = { calendar: await calendar.listTools() };
  const event = { summary: "TS · Morning run", start: "2026-11-17T07:00:00", end: "2026-11-17T07:30:00" };
  const s2 = scripted([
    toolCall("c4", "calendar_create-events", { events: [event] }),
    reply("No problem, I won't add it."),
  ]);
  const r2: any = await agent.generate("Add a run on Tuesday", { model: s2.model as any, memory, toolsets: calTools });
  assert.equal(r2.finishReason, "suspended", "calendar write paused for approval");
  assert.equal(existsSync(calLog), false, "nothing written before approval");
  const d: any = await agent.declineToolCallGenerate({
    runId: r2.runId, toolCallId: r2.suspendPayload?.toolCallId, memory, toolsets: calTools,
    model: s2.model as any, reason: "declined",
  });
  assert.equal(existsSync(calLog), false, "declined call never reached the calendar");
  console.log("✓ calendar write suspends; decline blocks it  →", JSON.stringify(d.text));

  // 3. Same request, approved: the write goes through.
  const s3 = scripted([toolCall("c5", "calendar_create-events", { events: [event] }), reply("Added your run.")]);
  const r3: any = await agent.generate("Add a run on Tuesday", { model: s3.model as any, memory, toolsets: calTools });
  assert.equal(r3.finishReason, "suspended");
  const a: any = await agent.approveToolCallGenerate({
    runId: r3.runId, toolCallId: r3.suspendPayload?.toolCallId, memory, toolsets: calTools, model: s3.model as any,
  });
  assert.equal(a.text, "Added your run.");
  assert.match(readFileSync(calLog, "utf8"), /Morning run/, "approved event was written");
  console.log("✓ approve lets the calendar write through");

  // 4. Read-only calendar tools don't need approval.
  assert.equal(calendarApproval({ toolName: "calendar_list-events" }), false);
  assert.equal(calendarApproval({ toolName: "calendar_delete-event" }), true);
  console.log("✓ reads run freely, writes and deletes need approval");

  console.log("\nAll wiring checks passed.");
} finally {
  await calendar.disconnect();
  await mcp.disconnect();
  rmSync(tmp, { recursive: true, force: true });
}
