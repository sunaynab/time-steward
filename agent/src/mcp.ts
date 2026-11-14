import { MCPClient } from "@mastra/mcp";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// agent/src (or agent/dist) -> repo root -> mcp/dist/index.js
const STEWARD_SERVER = resolve(here, "../../mcp/dist/index.js");
// Installed as a dependency, so startup doesn't download it through npx every time.
const CALENDAR_SERVER = createRequire(import.meta.url).resolve("@cocal/google-calendar-mcp/build/index.js");

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

export const calendarEnabled = Boolean(process.env.GOOGLE_OAUTH_CREDENTIALS);

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
            args: [CALENDAR_SERVER],
            env: passEnv("GOOGLE_OAUTH_CREDENTIALS", "HOME"),
            requireToolApproval: calendarApproval,
          },
        }
      : {}),
  },
});
