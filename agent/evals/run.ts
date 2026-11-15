// Time Steward evals. Runs each case against the real agent (your model, instructions,
// memory and MCP servers) with an isolated database and a stand-in calendar.
//
//   npm run eval                          all cases, 1 trial
//   npm run eval -- --trials 3            repeat each case to measure consistency
//   npm run eval -- --only safety         categories or case ids, comma-separated
//   npm run eval -- --model anthropic/claude-haiku-5-5
//   npm run eval -- --no-judge            skip the LLM-judged quality check
import "dotenv/config";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Case } from "./cases.js";
import type { Ctx, CheckResult, ToolCall } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

export type CaseResult = {
  id: string; category: string; trial: number; pass: boolean;
  checks: CheckResult[]; ms: number; tokens: number; error?: string; replies: string[]; calls: string[];
};

export async function runSuite(opts: {
  trials?: number; only?: string; model?: any; judge?: boolean; judgeModel?: any; quiet?: boolean;
} = {}) {
  // Isolate everything from your real data before the agent loads.
  const tmp = mkdtempSync(join(tmpdir(), "ts-eval-"));
  process.env.HOME = tmp;
  process.env.TIME_STEWARD_DB = join(tmp, "steward.db");
  process.env.TIME_STEWARD_CALENDAR_SERVER = join(here, "calendar-server.ts");
  delete process.env.GOOGLE_OAUTH_CREDENTIALS;

  const { agent } = await import("../src/agent.js");
  const { mcp } = await import("../src/mcp.js");
  const { cases } = await import("./cases.js");
  const db = new DatabaseSync(process.env.TIME_STEWARD_DB);
  const calFile = join(tmp, "eval-calendar.json");

  let judge: Ctx["judge"];
  if (opts.judge !== false) {
    const { Agent } = await import("@mastra/core/agent");
    const judgeAgent = new Agent({
      id: "eval-judge", name: "Eval judge",
      instructions: "You grade an assistant's reply against a rubric. Be strict and literal.",
      model: opts.judgeModel ?? process.env.EVAL_JUDGE_MODEL ?? "anthropic/claude-haiku-5-5",
    });
    const schema = z.object({ criteria_met: z.number().int(), pass: z.boolean(), reasoning: z.string() });
    judge = async (rubric, reply) => {
      const r: any = await judgeAgent.generate(`Rubric:\n${rubric}\n\nReply to grade:\n"""${reply}"""`, {
        structuredOutput: { schema },
      });
      const o = r.object;
      return { pass: !!o?.pass, detail: `${o?.criteria_met}/6 · ${o?.reasoning ?? ""}`.slice(0, 300) };
    };
  }

  const wanted = opts.only?.split(",").map((s) => s.trim()).filter(Boolean);
  const selected = cases.filter((c: Case) => !wanted?.length || wanted.some((w) => c.category === w || c.id.includes(w)));
  const results: CaseResult[] = [];
  const trials = opts.trials ?? 1;

  for (let trial = 1; trial <= trials; trial++) {
    for (const c of selected) {
      const t0 = Date.now();
      const res: CaseResult = { id: c.id, category: c.category, trial, pass: false, checks: [], ms: 0, tokens: 0, replies: [], calls: [] };
      try {
        // reset + seed
        const seed = c.seed();
        db.exec("DELETE FROM goals; DELETE FROM time_log;");
        const now = new Date().toISOString();
        for (const g of seed.goals ?? [])
          db.prepare("INSERT INTO goals (category, target_minutes, kind, note, updated_at) VALUES (?, ?, ?, NULL, ?)").run(g.category, g.target_minutes, g.kind, now);
        for (const l of seed.logs ?? [])
          db.prepare("INSERT INTO time_log (category, minutes, note, log_date, created_at) VALUES (?, ?, ?, ?, ?)").run(l.category, l.minutes, l.note ?? null, l.date, now);
        writeFileSync(calFile, JSON.stringify({ events: (seed.calendar ?? []).map((e, i) => ({ id: `seed${i + 1}`, ...e })), writes: [] }));

        // run the conversation in a fresh memory thread
        const memory = { resource: `eval-${c.id}-${trial}-${Date.now()}`, thread: `eval-${c.id}-${trial}` };
        const calls: ToolCall[] = [];
        const seen = new Set<string>();
        const record = (r: any, turn: number) => {
          res.tokens += r?.usage?.totalTokens ?? 0;
          for (const s of r?.steps ?? [])
            for (const tc of s.toolCalls ?? []) {
              const p = tc.payload ?? tc;
              if (seen.has(p.toolCallId)) continue;
              seen.add(p.toolCallId);
              calls.push({ tool: String(p.toolName).replace(/^(steward|calendar)_/, ""), args: p.args, turn });
            }
        };
        const extra = opts.model ? { model: opts.model } : {};
        for (const [turn, text] of c.turns.entries()) {
          let r: any = await agent.generate(text, { memory, ...extra });
          record(r, turn);
          while (r.finishReason === "suspended") {
            const p = r.suspendPayload ?? {};
            if (p.toolCallId && !seen.has(p.toolCallId)) {
              seen.add(p.toolCallId);
              calls.push({ tool: String(p.toolName).replace(/^calendar_/, ""), args: p.args, turn, suspended: true });
            }
            const o = { runId: r.runId, toolCallId: p.toolCallId, memory, ...extra };
            r = c.approve ? await agent.approveToolCallGenerate(o) : await agent.declineToolCallGenerate({ ...o, reason: "The user declined." });
            record(r, turn);
          }
          res.replies.push(r.text ?? "");
        }

        // score
        const state = JSON.parse(readFileSync(calFile, "utf8"));
        const ctx: Ctx = {
          replies: res.replies,
          calls,
          logs: db.prepare("SELECT category, minutes, log_date, note FROM time_log").all() as any,
          writes: state.writes,
          events: state.events,
          judge,
        };
        for (const check of c.checks()) res.checks.push(await check(ctx));
        res.calls = calls.map((x) => x.tool + (x.suspended ? " (paused)" : ""));
        res.pass = res.checks.every((k) => k.pass !== false);
      } catch (err) {
        res.error = err instanceof Error ? err.message : String(err);
      }
      res.ms = Date.now() - t0;
      results.push(res);
      if (!opts.quiet) printCase(res, c.description);
    }
  }

  await mcp.disconnect();
  return { results, selected: selected.length, trials };
}

// ---------------- reporting
const C = { g: "\x1b[32m", r: "\x1b[31m", d: "\x1b[2m", y: "\x1b[33m", x: "\x1b[0m" };
function printCase(r: CaseResult, description: string) {
  const mark = r.error ? `${C.r}ERR ${C.x}` : r.pass ? `${C.g}PASS${C.x}` : `${C.r}FAIL${C.x}`;
  console.log(`${mark} ${r.category.padEnd(11)} ${r.id}${r.trial > 1 ? ` #${r.trial}` : ""} ${C.d}${description} · ${(r.ms / 1000).toFixed(1)}s${C.x}`);
  if (r.error) console.log(`     ${C.r}${r.error}${C.x}`);
  for (const k of r.checks)
    if (k.pass !== true)
      console.log(`     ${k.pass === null ? C.y + "skip" : C.r + "✗"}${C.x} ${k.name}${k.detail ? `${C.d} → ${k.detail}${C.x}` : ""}`);
}

export function summarize(results: CaseResult[], meta: Record<string, string>) {
  const cats = [...new Set(results.map((r) => r.category))];
  const ids = [...new Set(results.map((r) => r.id))];
  const rate = (rs: CaseResult[]) => (rs.length ? rs.filter((r) => r.pass).length / rs.length : 0);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const checks = results.flatMap((r) => r.checks).filter((k) => k.pass !== null);
  const trials = Math.max(...results.map((r) => r.trial));
  const consistent = ids.filter((id) => results.filter((r) => r.id === id).every((r) => r.pass)).length;

  const lines = [
    `# Time Steward eval results`,
    ``,
    Object.entries(meta).map(([k, v]) => `**${k}:** ${v}`).join(" · "),
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Case pass rate | **${pct(rate(results))}** (${results.filter((r) => r.pass).length}/${results.length} runs) |`,
    `| Check pass rate | ${pct(checks.filter((k) => k.pass).length / (checks.length || 1))} (${checks.filter((k) => k.pass).length}/${checks.length}) |`,
    ...(trials > 1 ? [`| Passed every trial | ${consistent}/${ids.length} cases |`] : []),
    `| Median latency per case | ${(median(results.map((r) => r.ms)) / 1000).toFixed(1)}s |`,
    `| Tokens per case (avg) | ${Math.round(results.reduce((a, r) => a + r.tokens, 0) / (results.length || 1)).toLocaleString()} |`,
    ``,
    `| Category | Pass rate |`,
    `|---|---|`,
    ...cats.map((c) => { const rs = results.filter((r) => r.category === c); return `| ${c} | ${pct(rate(rs))} (${rs.filter((r) => r.pass).length}/${rs.length}) |`; }),
    ``,
    `## Failures`,
    ``,
    ...(results.some((r) => !r.pass)
      ? results.filter((r) => !r.pass).flatMap((r) => [
          `- **${r.id}**${trials > 1 ? ` (trial ${r.trial})` : ""}${r.error ? `: error: ${r.error}` : ""}`,
          ...r.checks.filter((k) => k.pass === false).map((k) => `  - ✗ ${k.name}${k.detail ? `: ${k.detail.replace(/\n/g, " ")}` : ""}`),
        ])
      : ["None."]),
  ];
  return lines.join("\n");
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// ---------------- CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      trials: { type: "string", default: "1" },
      only: { type: "string" },
      model: { type: "string" },
      "judge-model": { type: "string" },
      "no-judge": { type: "boolean", default: false },
    },
  });
  if (values.model) process.env.TIME_STEWARD_MODEL = values.model;
  const model = process.env.TIME_STEWARD_MODEL ?? "anthropic/claude-sonnet-5-5";
  if (!process.env.ANTHROPIC_API_KEY && model.startsWith("anthropic/")) {
    console.error("Set ANTHROPIC_API_KEY in agent/.env first.");
    process.exit(1);
  }
  console.log(`Running evals · model ${model}${values["no-judge"] ? " · no judge" : ""}\n`);
  const { results, trials } = await runSuite({
    trials: Number(values.trials), only: values.only, judge: !values["no-judge"], judgeModel: values["judge-model"],
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const report = summarize(results, { Model: model, Date: new Date().toLocaleString(), Trials: String(trials) });
  const outDir = join(here, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ model, trials, results }, null, 2));
  writeFileSync(join(outDir, "latest.md"), report);
  console.log(`\n${report.split("\n## Failures")[0]}\nFull report: evals/results/latest.md`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
