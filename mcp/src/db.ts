import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Where the data lives. Override with TIME_STEWARD_DB=/path/to/file.db
const DB_PATH =
  process.env.TIME_STEWARD_DB ?? join(homedir(), ".time-steward", "time-steward.db");

mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    category        TEXT PRIMARY KEY,
    target_minutes  INTEGER NOT NULL,          -- per week
    kind            TEXT NOT NULL CHECK (kind IN ('at_least','at_most')),
    note            TEXT,
    updated_at      TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS time_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,
    minutes     INTEGER NOT NULL CHECK (minutes > 0),
    note        TEXT,
    log_date    TEXT NOT NULL,                 -- YYYY-MM-DD, local time
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_log_date ON time_log(log_date);
`);

export const normalize = (c: string) => c.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** YYYY-MM-DD in the machine's local time zone. */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Monday of the week containing `date` (YYYY-MM-DD). */
export function weekStart(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const offset = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - offset);
  return localDate(d);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDate(d);
}
