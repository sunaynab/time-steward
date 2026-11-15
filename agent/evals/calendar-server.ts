// Stand-in Google Calendar MCP server for evals. Same tool names as
// @cocal/google-calendar-mcp, so the agent's instructions and approval policy apply
// unchanged. State lives in $HOME/eval-calendar.json, which the eval runner resets per case.
import { MCPServer } from "@mastra/mcp";
import { createTool } from "@mastra/core/tools";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

type Event = { id: string; summary: string; start: string; end: string; description?: string };
type State = { events: Event[]; writes: { tool: string; args: any }[] };

const FILE = join(process.env.HOME ?? ".", "eval-calendar.json");
const load = (): State => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { events: [], writes: [] });
const save = (s: State) => writeFileSync(FILE, JSON.stringify(s, null, 2));
const inRange = (e: Event, min?: string, max?: string) =>
  (!max || Date.parse(e.start) < Date.parse(max)) && (!min || Date.parse(e.end) > Date.parse(min));

const eventInput = z
  .object({ summary: z.string(), start: z.string(), end: z.string(), description: z.string().optional() })
  .passthrough();

const tools = {
  "list-events": createTool({
    id: "list-events",
    description: "List events from one or more calendars.",
    inputSchema: z.object({ calendarId: z.any().optional(), timeMin: z.string().optional(), timeMax: z.string().optional() }).passthrough(),
    execute: async ({ timeMin, timeMax }) => ({
      events: load().events.filter((e) => inRange(e, timeMin, timeMax)),
    }),
  }),
  "search-events": createTool({
    id: "search-events",
    description: "Search for events by text.",
    inputSchema: z.object({ query: z.string(), timeMin: z.string().optional(), timeMax: z.string().optional() }).passthrough(),
    execute: async ({ query, timeMin, timeMax }) => ({
      events: load().events.filter(
        (e) => inRange(e, timeMin, timeMax) && `${e.summary} ${e.description ?? ""}`.toLowerCase().includes(query.toLowerCase()),
      ),
    }),
  }),
  "get-freebusy": createTool({
    id: "get-freebusy",
    description: "Query free/busy information for calendars.",
    inputSchema: z.object({ timeMin: z.string(), timeMax: z.string(), calendars: z.any().optional() }).passthrough(),
    execute: async ({ timeMin, timeMax }) => ({
      calendars: { primary: { busy: load().events.filter((e) => inRange(e, timeMin, timeMax)).map(({ start, end }) => ({ start, end })) } },
    }),
  }),
  "create-event": createTool({
    id: "create-event",
    description: "Create a new calendar event.",
    inputSchema: eventInput.extend({ calendarId: z.string().optional() }),
    execute: async (args) => {
      const s = load();
      const ev = { id: `ev${s.events.length + 1}`, summary: args.summary, start: args.start, end: args.end, description: args.description };
      s.events.push(ev);
      s.writes.push({ tool: "create-event", args });
      save(s);
      return { created: ev };
    },
  }),
  "create-events": createTool({
    id: "create-events",
    description: "Create multiple calendar events in bulk.",
    inputSchema: z.object({ events: z.array(eventInput), calendarId: z.string().optional(), timeZone: z.string().optional() }).passthrough(),
    execute: async (args) => {
      const s = load();
      const created = args.events.map((e: any, i: number) => ({ id: `ev${s.events.length + i + 1}`, summary: e.summary, start: e.start, end: e.end }));
      s.events.push(...created);
      s.writes.push({ tool: "create-events", args });
      save(s);
      return { created };
    },
  }),
  "update-event": createTool({
    id: "update-event",
    description: "Update an existing calendar event.",
    inputSchema: z.object({ eventId: z.string(), calendarId: z.string().optional() }).passthrough(),
    execute: async (args) => {
      const s = load();
      s.writes.push({ tool: "update-event", args });
      save(s);
      return { updated: args.eventId };
    },
  }),
  "delete-event": createTool({
    id: "delete-event",
    description: "Delete a calendar event.",
    inputSchema: z.object({ eventId: z.string(), calendarId: z.string().optional() }).passthrough(),
    execute: async (args) => {
      const s = load();
      s.events = s.events.filter((e) => e.id !== args.eventId);
      s.writes.push({ tool: "delete-event", args });
      save(s);
      return { deleted: args.eventId };
    },
  }),
};

await new MCPServer({ id: "eval-calendar", name: "Eval Calendar", version: "0.0.0", tools }).startStdio();
