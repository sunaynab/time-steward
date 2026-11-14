#!/usr/bin/env node
import { MCPServer } from "@mastra/mcp";
import { allTools } from "./tools.js";

// stdout is the MCP channel: never console.log here. Use console.error for debugging.
const server = new MCPServer({
  id: "time-steward",
  name: "Time Steward",
  version: "0.1.0",
  description: "Weekly time goals and an activity log, with planned-vs-actual summaries.",
  tools: allTools,
});

server.startStdio().catch((err) => {
  console.error("Time Steward MCP server failed to start:", err);
  process.exit(1);
});
