import { MCPClient } from "@mastra/mcp";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Find the agent/ folder. The terminal app runs from dist/, but the playground bundles
// this file into agent/.mastra/output/, so walk up from both this file and the cwd.
function findAgentRoot(): string {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (let dir of starts) {
    while (true) {
      if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "..", "mcp", "package.json"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("Couldn't find the time-steward agent folder (expected a sibling mcp/ folder).");
}
const AGENT_ROOT = findAgentRoot();
const STEWARD_SERVER = resolve(AGENT_ROOT, "../mcp/dist/index.js");
// Installed as a dependency, so startup doesn't download it through npx every time.
const CALENDAR_SERVER = createRequire(join(AGENT_ROOT, "package.json")).resolve(
  "@cocal/google-calendar-mcp/build/index.js",
);

// .env files don't expand "~", so do it here.
if (process.env.GOOGLE_OAUTH_CREDENTIALS?.startsWith("~/")) {
  process.env.GOOGLE_OAUTH_CREDENTIALS = resolve(homedir(), process.env.GOOGLE_OAUTH_CREDENTIALS.slice(2));
}

// Calendar tools that change your calendar. These always pause for your approval.
const CALENDAR_WRITES = new Set([
  "create-event",
  "create-events",
  "update-event",
  "delete-event",
  "respond-to-event",
]);

export const calendarApproval = ({ toolName }: { toolName: string }) =>
  CALENDAR_WRITES.has(toolName.replace(/^calendar_/, ""));

// Evals point this at a stand-in calendar server; normally unset.
const CALENDAR_OVERRIDE = process.env.TIME_STEWARD_CALENDAR_SERVER;

export const calendarEnabled = Boolean(process.env.GOOGLE_OAUTH_CREDENTIALS || CALENDAR_OVERRIDE);

// Stdio servers only inherit PATH/HOME from this process, so pass what they need explicitly.
const passEnv = (...keys: string[]) =>
  Object.fromEntries(keys.filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));

export const mcp = new MCPClient({
  id: "time-steward-agent",
  servers: {
    steward: {
      command: process.execPath, // the same Node that's running the agent
      args: [STEWARD_SERVER],
      env: passEnv("TIME_STEWARD_DB"),
    },
    ...(calendarEnabled
      ? {
          calendar: {
            command: process.execPath,
            args: CALENDAR_OVERRIDE
              ? [...(CALENDAR_OVERRIDE.endsWith(".ts") ? ["--import", "tsx"] : []), CALENDAR_OVERRIDE]
              : [CALENDAR_SERVER],
            env: passEnv("GOOGLE_OAUTH_CREDENTIALS", "HOME"),
            requireToolApproval: calendarApproval,
          },
        }
      : {}),
  },
});
