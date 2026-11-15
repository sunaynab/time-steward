import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { db, normalize, localDate, weekStart, addDays } from "./db.js";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const setGoals = createTool({
  id: "set_goals",
  description:
    "Create or update weekly time goals. Each goal is a category with a weekly target in minutes. " +
    "Use kind 'at_least' for things to do more of (sleep, exercise, reading) and 'at_most' for caps (TV). " +
    "Example: 8.5h sleep per night = 3570 minutes/week at_least.",
  inputSchema: z.object({
    goals: z
      .array(
        z.object({
          category: z.string().min(1).describe("e.g. sleep, exercise, stretching, reading, side_project, chores, tv"),
          target_minutes_per_week: z.number().int().positive(),
          kind: z.enum(["at_least", "at_most"]).default("at_least"),
          note: z.string().optional(),
        }),
      )
      .min(1),
  }),
  execute: async ({ goals }) => {
    const stmt = db.prepare(`
      INSERT INTO goals (category, target_minutes, kind, note, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(category) DO UPDATE SET
        target_minutes = excluded.target_minutes, kind = excluded.kind,
        note = excluded.note, updated_at = excluded.updated_at`);
    const now = new Date().toISOString();
    for (const g of goals) {
      stmt.run(normalize(g.category), g.target_minutes_per_week, g.kind, g.note ?? null, now);
    }
    return { saved: goals.map((g) => normalize(g.category)) };
  },
});

export const removeGoal = createTool({
  id: "remove_goal",
  description: "Stop tracking a goal category. Past log entries are kept.",
  inputSchema: z.object({ category: z.string().min(1) }),
  execute: async ({ category }) => {
    const r = db.prepare("DELETE FROM goals WHERE category = ?").run(normalize(category));
    return { removed: Number(r.changes) > 0 };
  },
});

export const logTime = createTool({
  id: "log_time",
  description:
    "Record time actually spent on a category. Call once per activity. " +
    "Convert durations to minutes (e.g. '2 hrs TV' -> category tv, 120). " +
    "Log sleep against the date the user woke up. Defaults to today.",
  inputSchema: z.object({
    category: z.string().min(1),
    minutes: z.number().int().positive(),
    note: z.string().optional(),
    date: dateStr.optional().describe("YYYY-MM-DD; defaults to today"),
  }),
  execute: async ({ category, minutes, note, date }) => {
    const logDate = date ?? localDate();
    const r = db
      .prepare(
        "INSERT INTO time_log (category, minutes, note, log_date, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(normalize(category), minutes, note ?? null, logDate, new Date().toISOString());
    const hasGoal = db.prepare("SELECT 1 FROM goals WHERE category = ?").get(normalize(category));
    return {
      id: Number(r.lastInsertRowid),
      category: normalize(category),
      minutes,
      date: logDate,
      ...(hasGoal ? {} : { warning: "No goal exists for this category; it will show as untracked." }),
    };
  },
});

export const listLogs = createTool({
  id: "list_logs",
  description: "List log entries for a date range (inclusive). Useful for reviewing or correcting entries.",
  inputSchema: z.object({
    from: dateStr.optional().describe("defaults to Monday of this week"),
    to: dateStr.optional().describe("defaults to today"),
    category: z.string().optional(),
  }),
  execute: async ({ from, to, category }) => {
    const today = localDate();
    const start = from ?? weekStart(today);
    const end = to ?? today;
    const rows = category
      ? db
          .prepare(
            "SELECT id, log_date, category, minutes, note FROM time_log WHERE log_date BETWEEN ? AND ? AND category = ? ORDER BY log_date, id",
          )
          .all(start, end, normalize(category))
      : db
          .prepare(
            "SELECT id, log_date, category, minutes, note FROM time_log WHERE log_date BETWEEN ? AND ? ORDER BY log_date, id",
          )
          .all(start, end);
    return { from: start, to: end, entries: rows };
  },
});

export const deleteLog = createTool({
  id: "delete_log",
  description: "Delete a single log entry by id (use list_logs to find ids). Use to fix mistakes.",
  inputSchema: z.object({ id: z.number().int().positive() }),
  execute: async ({ id }) => {
    const r = db.prepare("DELETE FROM time_log WHERE id = ?").run(id);
    return { deleted: Number(r.changes) > 0 };
  },
});

export const weekSummary = createTool({
  id: "week_summary",
  description:
    "Planned vs. actual time for a week (Mon–Sun). For each goal returns target, actual, " +
    "expected-by-now pace, percent of target, and a status: on_track, behind, met, over_cap, or near_cap. " +
    "Also lists categories logged without a goal.",
  inputSchema: z.object({
    week_of: dateStr.optional().describe("any date in the week; defaults to this week"),
  }),
  execute: async ({ week_of }) => {
    const today = localDate();
    const start = weekStart(week_of ?? today);
    const end = addDays(start, 6);

    // How much of the week has elapsed (counting today), for pacing.
    const daysElapsed =
      today < start ? 0 : today > end ? 7 : Math.round((Date.parse(today) - Date.parse(start)) / 864e5) + 1;

    const actuals = new Map<string, number>(
      (
        db
          .prepare(
            "SELECT category, SUM(minutes) AS total FROM time_log WHERE log_date BETWEEN ? AND ? GROUP BY category",
          )
          .all(start, end) as { category: string; total: number }[]
      ).map((r) => [r.category, Number(r.total)]),
    );

    const goals = db.prepare("SELECT category, target_minutes, kind FROM goals ORDER BY category").all() as {
      category: string;
      target_minutes: number;
      kind: "at_least" | "at_most";
    }[];

    const rows = goals.map((g) => {
      const actual = actuals.get(g.category) ?? 0;
      actuals.delete(g.category);
      const expected = Math.round((g.target_minutes * daysElapsed) / 7);
      const pct = Math.round((actual / g.target_minutes) * 100);
      let status: string;
      if (g.kind === "at_most") {
        status = actual > g.target_minutes ? "over_cap" : actual > expected ? "near_cap" : "on_track";
      } else {
        status = actual >= g.target_minutes ? "met" : actual >= expected * 0.9 ? "on_track" : "behind";
      }
      return {
        category: g.category,
        kind: g.kind,
        target_minutes: g.target_minutes,
        actual_minutes: actual,
        expected_by_now: expected,
        percent_of_target: pct,
        status,
      };
    });

    return {
      week: { start, end, days_elapsed: daysElapsed },
      goals: rows,
      untracked: [...actuals].map(([category, minutes]) => ({ category, minutes })),
    };
  },
});

export const allTools = {
  set_goals: setGoals,
  remove_goal: removeGoal,
  log_time: logTime,
  list_logs: listLogs,
  delete_log: deleteLog,
  week_summary: weekSummary,
};
