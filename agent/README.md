# Time Steward Agent

A [Mastra](https://mastra.ai) agent that plans your week around your goals and runs a nightly check-in. It uses two MCP servers:

- **steward**: the time-log server in `../mcp` (goals, logging, weekly summaries)
- **calendar** (optional): [Google Calendar MCP](https://github.com/nspady/google-calendar-mcp). Reads run freely; **every create, update or delete pauses for your y/n approval.**

## Setup

Requires Node 22.13+.

```bash
# 1. Build the MCP server the agent talks to
cd ../mcp && npm install && npm run build

# 2. Build the agent
cd ../agent && npm install && npm run build
cp .env.example .env    # then add your ANTHROPIC_API_KEY
```

## Use it

```bash
npm start           # chat; shortcuts: /checkin  /plan  /summary  /quit
npm run checkin     # jump straight into the nightly check-in
npm run plan        # plan next week
```

### Playground (web chat)

```bash
npm run playground
```

Then open http://localhost:4111/agents/time-steward/chat. Mastra Studio shows each tool call as it happens, and calendar writes appear with **Approve** / **Decline** buttons. It uses the same tools, memory and data as the terminal app. Studio's **Traces** tab shows what the agent did step by step, which is handy when it picks the wrong tool. Only one playground can run at a time; stop it with Ctrl+C in its Terminal window.

First run: tell it your goals, e.g. *"Set my goals: 8.5h sleep a night, 3 x 30-min runs, 20 min stretching daily, 3h non-fiction reading, 5h side project, a 3h chore block, and at most 5h of TV."*

Memory and paused approvals live in `~/.time-steward/agent.db`; your time log is in `~/.time-steward/time-steward.db`.

## Connect Google Calendar (optional)

1. In Google Cloud Console, create a project, then enable the **Google Calendar API**.
2. Create an **OAuth client ID** with application type **Desktop app**, and download the JSON.
3. On the OAuth consent screen's **Audience** page, add your Google account as a **test user**.
4. Save the JSON as `~/.time-steward/gcp-oauth.keys.json`, and set `GOOGLE_OAUTH_CREDENTIALS` to that path in `.env`.
5. Authorize once, from this folder: `GOOGLE_OAUTH_CREDENTIALS=~/.time-steward/gcp-oauth.keys.json npx google-calendar-mcp auth`

While the Google app stays in test mode, tokens expire every 7 days. Rerun step 5 when calendar calls start failing.

## Troubleshooting

- **`EACCES: permission denied` under `~/.npm`**: some cache folders are owned by root (usually from an earlier `sudo npm`). Fix the ownership with `sudo chown -R $(id -u):$(id -g) ~/.npm`, then rerun `npm install`.
- **"calendar failed to start"**: the agent keeps running with your time-log tools. Check that `GOOGLE_OAUTH_CREDENTIALS` points to the JSON file, then rerun the auth step (test-mode tokens expire weekly).

## Test

```bash
npm test
```

This runs the real agent, MCP server and memory with a scripted mock model, so no API key is needed. It checks that tool calls reach SQLite, that calendar writes pause for approval, that declining blocks the write, and that approving lets it through.

## Evals

`npm test` checks the wiring. Evals check **behavior**: whether the real model, with these instructions and tools, does the right thing. Each case runs against an isolated database, a fresh memory thread and a stand-in calendar server (same tool names and approval policy as Google Calendar), then is scored on what actually happened: rows in SQLite, tools called, events written.

```bash
npm run eval                                   # all 16 cases (uses your API key)
npm run eval -- --trials 3                     # repeat to measure consistency
npm run eval -- --only safety,planning         # categories or case ids
npm run eval -- --model anthropic/claude-haiku-5-5   # compare models
npm run eval -- --no-judge                     # skip the LLM-graded check
npm run eval:selftest                          # prove the grader catches failures (no key needed)
```

| Category | What it checks |
|---|---|
| logging (7) | Plain language becomes the right entries: units, relative dates, sleep date rule, category mapping, asking when the duration is missing, nothing invented |
| corrections (1) | "Actually it was 20, not 30" fixes the entry instead of adding one |
| grounding (2) | Progress answers come from `week_summary` and match the real numbers |
| safety (3) | Proposes before writing, a declined approval writes nothing, and instructions planted in a calendar event are ignored |
| planning (2) | Approved plans fall in next week, avoid existing events, target the biggest gap, and respect user constraints |
| quality (1) | The check-in reply is short, specific and encouraging (graded by Claude Haiku against a rubric) |

Results print to the terminal and are saved to `evals/results/latest.md` (a shareable summary) plus a timestamped JSON file with every reply and tool call. A full run makes roughly 40–60 model calls.

## Layout

```
src/mcp.ts     MCPClient: steward server + optional calendar, approval policy
src/agent.ts   Agent, instructions, memory, Mastra instance with storage
src/cli.ts     Terminal chat with approve/decline prompts
src/mastra/    Entry point for the Studio playground
test/          Wiring test + fake calendar server
evals/         Eval cases, runner, stand-in calendar, grader self-test
```
