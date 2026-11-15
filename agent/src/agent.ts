import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mcp, calendarEnabled } from "./mcp.js";

// If a server fails to start (e.g. calendar auth expired), keep going with the tools that did.
const { tools, errors } = await mcp.listToolsWithErrors();
for (const [server, err] of Object.entries(errors)) {
  console.error(`⚠ ${server} tools unavailable: ${String(err).split("\n")[0]}`);
}
export const calendarReady = calendarEnabled && Object.keys(tools).some((t) => t.startsWith("calendar_"));

const DATA_DIR = join(homedir(), ".time-steward");
mkdirSync(DATA_DIR, { recursive: true });

// One local store for conversation memory and for runs paused awaiting your approval.
const storage = new LibSQLStore({ id: "time-steward-store", url: `file:${join(DATA_DIR, "agent.db")}` });

const memory = new Memory({
  storage,
  options: {
    lastMessages: 20,
    // Durable notes the agent keeps about you across conversations.
    workingMemory: {
      enabled: true,
      template: `# About me
- Typical wake time:
- Typical bedtime:
- Preferred workout times:
- Recurring commitments:
- What tends to derail my week:
`,
    },
  },
});

function instructions() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = now.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: tz,
  });
  return `You are Time Steward, a personal time coach. You help the user spend each week on what matters to them.

Today is ${today} (${tz}). Weeks run Monday to Sunday.

## Time log tools (steward_*)
- Goals are weekly targets in minutes. "at_least" = do more (sleep, exercise, reading, side project, chores). "at_most" = a cap (TV).
- When the user describes their day, call steward_log_time once per activity. Convert durations to minutes. Log sleep on the date they woke up. If the date or duration is ambiguous, ask instead of guessing.
- Use steward_week_summary for any question about progress. Never estimate numbers yourself.
- If the user corrects an entry, use steward_list_logs to find it and steward_delete_log, then log the right value.

## Nightly check-in
Ask briefly about sleep, movement, reading, side-project time, chores and TV. Log what they report, then give a short read from week_summary: one win, the biggest gap, and one concrete suggestion for tomorrow. Keep it to a few sentences. Be encouraging, never preachy.

## Weekly planning
${
  calendarReady
    ? `- Use calendar_list-events or calendar_get-freebusy to find open time in the requested week.
- Propose specific blocks that close the gaps from week_summary and goals: wind-down before bedtime, runs or walks, stretching, reading, side-project sessions, one weekend chore block. Respect existing events.
- Show the full proposed plan as a list first and ask for a go-ahead. Only after the user agrees, create events with calendar_create-events (prefix titles with "TS · "). Every calendar write also pauses for explicit approval.`
    : `- Calendar access isn't set up yet. Propose a weekly plan as a list of suggested blocks (day, time, activity) based on goals and week_summary, and say that connecting Google Calendar would let you place them automatically.`
}

## Style
Short and direct. Use the user's own category names. Times in 12-hour format.`;
}

const timeSteward = new Agent({
  id: "time-steward",
  name: "Time Steward",
  description: "Plans the week around personal goals and tracks planned vs. actual time.",
  instructions,
  model: process.env.TIME_STEWARD_MODEL ?? "anthropic/claude-sonnet-5-5",
  tools,
  memory,
});

export const mastra = new Mastra({ agents: { timeSteward }, storage });
export const agent = mastra.getAgent("timeSteward");
