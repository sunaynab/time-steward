#!/usr/bin/env node
import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const { agent, calendarReady } = await import("./agent.js");
const { mcp, calendarEnabled } = await import("./mcp.js");

const rl = readline.createInterface({ input, output });
const memory = { resource: "me", thread: "time-steward" };

const SHORTCUTS: Record<string, string> = {
  "/checkin": "Let's do my nightly check-in.",
  "/plan": "Help me plan next week around my goals.",
  "/summary": "How am I doing this week?",
};

function describeCall(payload: any) {
  const name = String(payload?.toolName ?? "a tool").replace(/^calendar_/, "");
  const args = payload?.args ?? {};
  const events = Array.isArray(args.events) ? args.events : [args];
  const lines = events.map(
    (e: any) => `   • ${e.summary ?? e.eventId ?? "(event)"}  ${e.start ?? ""}${e.end ? ` → ${e.end}` : ""}`,
  );
  return `\nTime Steward wants to run ${name}:\n${lines.join("\n")}`;
}

async function send(text: string) {
  let result: any = await agent.generate(text, { memory });

  // Calendar writes pause here until you approve or decline.
  while (result.finishReason === "suspended") {
    const payload = result.suspendPayload;
    console.log(describeCall(payload));
    const answer = (await rl.question("Approve? (y/n) ")).trim().toLowerCase();
    const opts = { runId: result.runId, toolCallId: payload?.toolCallId, memory };
    result =
      answer === "y" || answer === "yes"
        ? await agent.approveToolCallGenerate(opts)
        : await agent.declineToolCallGenerate({ ...opts, reason: "The user declined this change." });
  }
  console.log(`\n${result.text}\n`);
}

async function main() {
  const initial = process.argv.slice(2).join(" ").trim();
  console.log(
    `Time Steward ${
      calendarReady
        ? "(calendar connected)"
        : calendarEnabled
          ? "(calendar failed to start; see the warning above)"
          : "(no calendar: set GOOGLE_OAUTH_CREDENTIALS to enable)"
    }\n` +
      `Shortcuts: /checkin  /plan  /summary  /quit\n`,
  );

  if (initial) {
    // One-shot mode, e.g. `npm run checkin` from a scheduler.
    await send(SHORTCUTS[initial] ?? initial);
  }

  while (true) {
    const line = (await rl.question("you › ")).trim();
    if (!line) continue;
    if (line === "/quit" || line === "/exit") break;
    try {
      await send(SHORTCUTS[line] ?? line);
    } catch (err) {
      console.error("\nSomething went wrong:", err instanceof Error ? err.message : err, "\n");
    }
  }
}

try {
  await main();
} finally {
  rl.close();
  await mcp.disconnect();
}
