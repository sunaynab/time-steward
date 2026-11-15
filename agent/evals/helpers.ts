// Dates, seed builders and check functions shared by the eval cases.

export type ToolCall = { tool: string; args: any; turn: number; suspended?: boolean };
export type Ctx = {
  replies: string[];
  calls: ToolCall[]; // every tool the agent called or tried to call, including ones paused for approval
  logs: { category: string; minutes: number; log_date: string; note: string | null }[];
  writes: { tool: string; args: any }[]; // calendar writes that actually executed
  events: { id: string; summary: string; start: string; end: string }[]; // calendar after the case
  judge?: (rubric: string, reply: string) => Promise<{ pass: boolean; detail: string }>;
};
export type CheckResult = { name: string; pass: boolean | null; detail: string }; // null = skipped
export type Check = (ctx: Ctx) => CheckResult | Promise<CheckResult>;

// ---------- dates (local time, Mon–Sun weeks, matching the MCP server)
const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymd(new Date());
export function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
export const weekStart = (date = today()) => addDays(date, -((new Date(`${date}T12:00:00`).getDay() + 6) % 7));
export const daysElapsed = () => Math.round((Date.parse(`${today()}T12:00:00`) - Date.parse(`${weekStart()}T12:00:00`)) / 864e5) + 1;
export const nextWeek = () => {
  const start = addDays(weekStart(), 7);
  return { start, end: addDays(start, 6) };
};
/** Local date-time string on day `offset` of next week (0 = Monday). */
export const nextWeekAt = (offset: number, hhmm: string) => `${addDays(nextWeek().start, offset)}T${hhmm}:00`;

// ---------- seed builders
export const GOALS = [
  { category: "sleep", target_minutes: 3570, kind: "at_least" as const },
  { category: "exercise", target_minutes: 90, kind: "at_least" as const },
  { category: "stretching", target_minutes: 140, kind: "at_least" as const },
  { category: "reading", target_minutes: 180, kind: "at_least" as const },
  { category: "side_project", target_minutes: 300, kind: "at_least" as const },
  { category: "chores", target_minutes: 180, kind: "at_least" as const },
  { category: "tv", target_minutes: 300, kind: "at_most" as const },
];

/** The same amount on each day earlier this week (Monday through yesterday; none on Mondays). */
export function thisWeek(category: string, perDay: number) {
  return Array.from({ length: daysElapsed() - 1 }, (_, i) => ({ category, minutes: perDay, date: addDays(weekStart(), i) }));
}

// ---------- checks
const ok = (name: string, pass: boolean, detail = ""): CheckResult => ({ name, pass, detail });
const sum = (ctx: Ctx, category: string, date?: string) =>
  ctx.logs.filter((l) => l.category === category && (!date || l.log_date === date)).reduce((a, l) => a + l.minutes, 0);

export const logged =
  (category: string, minutes: number, opts: { date?: string; tolerance?: number } = {}): Check =>
  (ctx) => {
    const got = sum(ctx, category, opts.date);
    const tol = opts.tolerance ?? 0;
    return ok(
      `logged ${category} ${minutes}m${opts.date ? ` on ${opts.date}` : ""}`,
      Math.abs(got - minutes) <= tol,
      `got ${got}m`,
    );
  };

export const entryCount =
  (n: number, filter?: (l: Ctx["logs"][number]) => boolean, label = ""): Check =>
  (ctx) => {
    const got = ctx.logs.filter(filter ?? (() => true)).length;
    return ok(`${n} log entr${n === 1 ? "y" : "ies"}${label}`, got === n, `got ${got}`);
  };

export const called =
  (tool: string, turn?: number): Check =>
  (ctx) => {
    const hit = ctx.calls.some((c) => c.tool === tool && (turn === undefined || c.turn === turn));
    return ok(`called ${tool}${turn !== undefined ? ` in turn ${turn + 1}` : ""}`, hit, hit ? "" : `calls: ${toolList(ctx)}`);
  };

export const notCalled =
  (tools: string[], turn?: number, label?: string): Check =>
  (ctx) => {
    const hits = ctx.calls.filter((c) => tools.includes(c.tool) && (turn === undefined || c.turn === turn));
    return ok(label ?? `never called ${tools.join("/")}`, hits.length === 0, hits.map((h) => h.tool).join(", "));
  };

export const CALENDAR_WRITES = ["create-event", "create-events", "update-event", "delete-event", "respond-to-event"];

export const asksQuestion =
  (turn = -1): Check =>
  (ctx) => {
    const r = ctx.replies.at(turn) ?? "";
    return ok("asks a clarifying question", r.includes("?"), r.slice(0, 120));
  };

export const replyMatches =
  (re: RegExp, label: string, turn = -1): Check =>
  (ctx) => {
    const r = ctx.replies.at(turn) ?? "";
    return ok(label, re.test(r), r.slice(0, 160));
  };

/** Reply states a number consistent with the true total: minutes, hours, "Xh Ym", or percent of target. */
export const mentionsTotal =
  (label: string, minutes: number, target: number, turn = -1): Check =>
  (ctx) => {
    const r = (ctx.replies.at(turn) ?? "").replace(/,/g, "");
    const hours = minutes / 60;
    const pct = (minutes / target) * 100;
    const hm = [...r.matchAll(/(\d+)\s*h(?:ours?|rs?)?\s*(?:and\s*)?(\d+)\s*m/gi)].map((m) => +m[1] * 60 + +m[2]);
    const nums = [...r.matchAll(/\d+(?:\.\d+)?/g)].map((m) => +m[0]);
    const pass =
      hm.some((m) => Math.abs(m - minutes) <= 10) ||
      nums.some((n) => Math.abs(n - hours) <= 0.6 || Math.abs(n - minutes) <= 5) ||
      [...r.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].some((m) => Math.abs(+m[1] - pct) <= 2);
    return ok(`${label} matches the log (${hours.toFixed(1)}h, ${pct.toFixed(0)}%)`, pass, r.slice(0, 160));
  };

const created = (ctx: Ctx) =>
  ctx.writes.flatMap((w) => (w.tool === "create-events" ? w.args.events : w.tool === "create-event" ? [w.args] : []));

export const createdEvents =
  (min: number, max = 30): Check =>
  (ctx) => {
    const n = created(ctx).length;
    return ok(`created ${min}–${max} events`, n >= min && n <= max, `created ${n}`);
  };

export const eventsInNextWeek: Check = (ctx) => {
  const { start, end } = nextWeek();
  const lo = Date.parse(`${start}T00:00:00`), hi = Date.parse(`${addDays(end, 1)}T00:00:00`);
  const bad = created(ctx).filter((e: any) => !(Date.parse(e.start) >= lo && Date.parse(e.end) <= hi));
  return ok(`all events fall in ${start}…${end}`, bad.length === 0, bad.map((e: any) => `${e.summary} ${e.start}`).join("; "));
};

export const noOverlaps =
  (busy: { summary: string; start: string; end: string }[]): Check =>
  (ctx) => {
    const evs = created(ctx);
    const clash: string[] = [];
    const overlaps = (a: any, b: any) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
    evs.forEach((e: any, i: number) => {
      busy.forEach((b) => overlaps(e, b) && clash.push(`${e.summary} × ${b.summary}`));
      evs.slice(i + 1).forEach((f: any) => overlaps(e, f) && clash.push(`${e.summary} × ${f.summary}`));
    });
    return ok("no overlaps with existing events or each other", clash.length === 0, clash.join("; "));
  };

export const titlesPrefixed: Check = (ctx) => {
  const bad = created(ctx).filter((e: any) => !/^TS\s*·/.test(e.summary));
  return ok('event titles start with "TS ·"', bad.length === 0, bad.map((e: any) => e.summary).join("; "));
};

export const targetsGap =
  (re: RegExp, label: string): Check =>
  (ctx) => {
    const hit = created(ctx).some((e: any) => re.test(e.summary));
    return ok(`plan includes ${label}`, hit, created(ctx).map((e: any) => e.summary).join("; "));
  };

export const respectsWindow =
  (label: string, bad: (start: Date) => boolean): Check =>
  (ctx) => {
    const v = created(ctx).filter((e: any) => bad(new Date(e.start)));
    return ok(label, v.length === 0, v.map((e: any) => `${e.summary} ${e.start}`).join("; "));
  };

export const noCalendarWrites: Check = (ctx) =>
  ok("nothing written to the calendar", ctx.writes.length === 0, ctx.writes.map((w) => w.tool).join(", "));

export const judged =
  (rubric: string, turn = -1): Check =>
  async (ctx) => {
    if (!ctx.judge) return { name: "judge: reply quality", pass: null, detail: "skipped (--no-judge)" };
    const r = await ctx.judge(rubric, ctx.replies.at(turn) ?? "");
    return { name: "judge: reply quality", ...r };
  };

function toolList(ctx: Ctx) {
  return ctx.calls.map((c) => c.tool).join(", ") || "none";
}
