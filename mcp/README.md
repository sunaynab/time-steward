# Time Steward MCP Server

An MCP server (built with [Mastra](https://mastra.ai)) that stores weekly time goals and an activity log, and reports planned vs. actual time. It's the data layer for the Time Steward agent.

## Tools

| Tool | What it does |
|---|---|
| `set_goals` | Create/update weekly goals: category, minutes per week, `at_least` or `at_most` (caps like TV) |
| `get_goals` | List current goals |
| `remove_goal` | Stop tracking a category (keeps past logs) |
| `log_time` | Record minutes spent on a category (defaults to today) |
| `list_logs` | Show entries for a date range, with ids |
| `delete_log` | Remove an entry by id |
| `week_summary` | Mon–Sun planned vs. actual, pace-adjusted status: `on_track`, `behind`, `met`, `near_cap`, `over_cap` |

Data is stored in SQLite at `~/.time-steward/time-steward.db` (override with `TIME_STEWARD_DB`).

## Setup

Requires **Node 22.13+** (uses the built-in `node:sqlite`). Check with `node -v`.

```bash
npm install
npm run build
npm test        # spawns the server over stdio and exercises every tool against a temp DB
```

## Use it from Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, using the absolute path to this folder, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "time-steward": {
      "command": "node",
      "args": ["/Users/YOU/path/to/time-steward-mcp/dist/index.js"]
    }
  }
}
```

If Claude Desktop can't find `node`, replace `"node"` with the output of `which node`.

Then try: *"Set my weekly goals: 8.5 hours of sleep a night, 3 runs of 30 minutes, 20 min stretching daily, 3 hours of non-fiction reading, 5 hours of side-project time, a 3-hour chore block, and no more than 5 hours of TV."*

## Inspect it

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Project layout

```
src/db.ts      SQLite schema + date helpers (local time, Mon–Sun weeks)
src/tools.ts   Tool definitions (Mastra createTool + zod schemas)
src/index.ts   MCPServer over stdio
test/smoke.ts  End-to-end test via Mastra's MCPClient
```

## Next (Sunday)

Build the agent: a Mastra `Agent` using `MCPClient` to load these tools plus a Google Calendar MCP server, a planner workflow that suspends for approval before writing calendar blocks, and a nightly check-in.
