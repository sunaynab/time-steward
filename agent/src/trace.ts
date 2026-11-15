// One short, dim line per tool the agent called, so you can see what it actually did.
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function summarizeArgs(tool: string, args: Record<string, any> = {}): string {
  switch (tool) {
    case "log_time":
      return `${args.category} · ${args.minutes} min${args.date ? ` · ${args.date}` : ""}`;
    case "set_goals":
      return `${args.goals?.length ?? 0} goals`;
    case "create-events":
      return `${args.events?.length ?? 1} events`;
    default: {
      const parts = Object.entries(args)
        .filter(([, v]) => v !== undefined && typeof v !== "object")
        .map(([k, v]) => `${k}=${typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : v}`);
      return parts.join(" ").slice(0, 60);
    }
  }
}

export function toolLines(result: any): string[] {
  const calls = (result?.steps ?? []).flatMap((s: any) => s.toolCalls ?? []);
  return calls.map((c: any) => {
    const p = c.payload ?? c;
    const tool = String(p.toolName ?? "").replace(/^(steward|calendar)_/, "");
    const args = summarizeArgs(tool, p.args);
    return `  · ${tool}${args ? `  ${args}` : ""}`;
  });
}

export function printToolTrace(result: any) {
  for (const line of toolLines(result)) console.log(`${DIM}${line}${RESET}`);
}

function when(start?: string, end?: string): string {
  const s = start ? new Date(start) : undefined;
  if (!s || isNaN(+s)) return [start, end].filter(Boolean).join(" → ");
  const day = s.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const t = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const e = end ? new Date(end) : undefined;
  return `${day}, ${t(s)}${e && !isNaN(+e) ? ` – ${t(e)}` : ""}`;
}

/** The approval prompt shown before a calendar write. */
export function describeCall(payload: any): string {
  const name = String(payload?.toolName ?? "a tool").replace(/^calendar_/, "");
  const args = payload?.args ?? {};
  const events = Array.isArray(args.events) ? args.events : [args];
  const lines = events.map((e: any) => `   • ${e.summary ?? e.eventId ?? "(event)"}   ${when(e.start, e.end)}`);
  return `\nTime Steward wants to run ${name}:\n${lines.join("\n")}`;
}
