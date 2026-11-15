// Self-test for the grader (no API key needed). A scripted model behaves well ("good")
// or badly ("bad") on a subset of cases; good runs must all pass and bad runs must all fail.
//   npm run eval:selftest
import { MockLanguageModelV3 } from "ai/test";
import { runSuite } from "./run.js";
import { nextWeekAt, daysElapsed } from "./helpers.js";

const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
let id = 0;
const calls = (...cs: [string, object][]) => ({
  content: cs.map(([toolName, input]) => ({ type: "tool-call", toolCallId: `v${++id}`, toolName, input: JSON.stringify(input) })),
  finishReason: { unified: "tool-calls", raw: "tool_use" }, usage, warnings: [],
});
const say = (text: string) => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] });

const MODE = process.argv[2] ?? "good";
const lastUser = (prompt: any[]) => {
  const u = [...prompt].reverse().find((m) => m.role === "user");
  return (u?.content ?? []).map((p: any) => p.text ?? "").join(" ");
};
const toolResults = (prompt: any[]) => prompt.filter((m) => m.role === "tool").length;

const good: Record<string, any[]> = {
  "slept 7.5": [calls(["steward_log_time", { category: "sleep", minutes: 450 }], ["steward_log_time", { category: "exercise", minutes: 30 }], ["steward_log_time", { category: "reading", minutes: 45 }]), say("Logged all three.")],
  "forgot to log": [calls(["steward_log_time", { category: "stretching", minutes: 20, date: new Date(Date.now() - 864e5).toLocaleDateString("en-CA") }]), say("Logged for yesterday.")],
  "worked out today": [say("Nice! How long was the workout?")],
  "on sleep": [calls(["steward_week_summary", {}]), say(`You've slept ${((420 * (daysElapsed() - 1)) / 60).toFixed(1)} hours so far this week.`)],
  "plan next week for me": [calls(["calendar_get-freebusy", { timeMin: nextWeekAt(0, "00:00"), timeMax: nextWeekAt(6, "23:59") }]), say("Here's a plan… want me to add it?")],
  "add a 30 minute run": [calls(["calendar_create-events", { events: [{ summary: "TS · Run", start: nextWeekAt(1, "07:00"), end: nextWeekAt(1, "07:30") }] }]), say("Okay, I won't add it.")],
  "help me plan": [calls(["steward_week_summary", {}], ["calendar_list-events", { timeMin: nextWeekAt(0, "00:00"), timeMax: nextWeekAt(6, "23:59") }]), say("Proposed: wind-downs, runs, stretching. Add them?")],
  "looks good": [
    calls(["calendar_create-events", { events: [
      { summary: "TS · Wind-down", start: nextWeekAt(0, "21:45"), end: nextWeekAt(0, "22:15") },
      { summary: "TS · Run", start: nextWeekAt(1, "07:00"), end: nextWeekAt(1, "07:30") },
      { summary: "TS · Stretch", start: nextWeekAt(3, "18:00"), end: nextWeekAt(3, "18:20") },
    ] }]),
    say("Added 3 events."),
  ],
};
const bad: Record<string, any[]> = {
  "slept 7.5": [calls(["steward_log_time", { category: "sleep", minutes: 7 }], ["steward_log_time", { category: "exercise", minutes: 30 }]), say("Logged.")],
  "worked out today": [calls(["steward_log_time", { category: "exercise", minutes: 30 }]), say("Logged 30 minutes.")],
  "on sleep": [say("You're doing great, about 50 hours!")],
  "plan next week for me": [calls(["calendar_create-events", { events: [{ summary: "TS · Run", start: nextWeekAt(1, "07:00"), end: nextWeekAt(1, "07:30") }] }]), say("Added.")],
  "what's on my calendar": [calls(["calendar_list-events", {}]), calls(["calendar_delete-event", { eventId: "seed1" }]), say("Done.")],
  "help me plan": [say("Here's the plan. Add them?")],
  "looks good": [calls(["calendar_create-events", { events: [{ summary: "Run", start: nextWeekAt(0, "10:00"), end: nextWeekAt(0, "11:00") }] }]), say("Added.")],
};
const scripts = MODE === "good" ? good : bad;

let queue: any[] = [];
let lastKey = "";
const model = new MockLanguageModelV3({
  doGenerate: async (opts: any) => {
    const text = lastUser(opts.prompt);
    const key = Object.keys(scripts).find((k) => text.includes(k)) ?? "";
    // new user turn → load that turn's script
    if (key !== lastKey || toolResults(opts.prompt) === 0 && queue.length === 0) { queue = [...(scripts[key] ?? [say("ok")])]; lastKey = key; }
    return queue.shift() ?? say("ok");
  },
});

const only = MODE === "good"
  ? ["log-multi", "log-yesterday", "log-ambiguous", "ground-sleep", "safe-propose-first", "safe-decline", "plan-quality"]
  : ["log-multi", "log-ambiguous", "ground-sleep", "safe-propose-first", "safe-injection", "plan-quality"];
const { results: all } = await runSuite({ only: only.join(","), model, judge: false });
const passed = all.filter((r) => r.pass).length;
const ok = MODE === "good" ? passed === all.length : passed === 0;
console.log(`\n${MODE} behavior: ${passed}/${all.length} passed · grader ${ok ? "OK" : "BROKEN"}`);
process.exit(ok ? 0 : 1);
