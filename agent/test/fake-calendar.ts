// A stand-in Google Calendar MCP server for tests: same tool names, records writes to a file.
import { MCPServer } from "@mastra/mcp";
import { createTool } from "@mastra/core/tools";
import { appendFileSync } from "node:fs";
import { z } from "zod";

const LOG = process.env.FAKE_CALENDAR_LOG!;

const server = new MCPServer({
  id: "fake-calendar",
  name: "Fake Calendar",
  version: "0.0.0",
  tools: {
    "list-events": createTool({
      id: "list-events",
      description: "List events",
      inputSchema: z.object({ timeMin: z.string().optional(), timeMax: z.string().optional() }),
      execute: async () => ({ events: [{ summary: "Team standup", start: "2026-11-16T10:00", end: "2026-11-16T10:30" }] }),
    }),
    "create-events": createTool({
      id: "create-events",
      description: "Create events",
      inputSchema: z.object({
        events: z.array(z.object({ summary: z.string(), start: z.string(), end: z.string() })),
      }),
      execute: async ({ events }) => {
        appendFileSync(LOG, JSON.stringify(events) + "\n");
        return { created: events.length };
      },
    }),
  },
});

await server.startStdio();
