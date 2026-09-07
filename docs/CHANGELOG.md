# Changelog

All notable changes to webcrawl. This project keeps every prior capability working —
changes are **additive and backward-compatible** unless noted.

## Unreleased — Unified intent-first research + agentic workspace

A major, **zero-function-loss** expansion of Simple Mode into a unified research and agentic
workspace. Every existing route, MCP tool, Advanced-Mode panel, local-LLM/provider selector and
WebUI feature is preserved and still verified by tests.

### Added

- **Unlimited intent input** — the goal box takes an arbitrarily long brief (no length cap).
- **Multi-source runs** — target any combination of: entire web, specific domains, specific URLs,
  **local files** (allow-listed), **GitHub**, **MCP tools**, and a **previous workspace**.
- **Research domain selector** — General, Academic, News, Technical/Code, Legal, Medical,
  Financial, Market/Competitive, Social, Government (biases planning & source weighting).
- **Depth presets** — Quick / Standard / Deep / **Exhaustive** / **Custom** (custom limits).
- **Agent autonomy modes** — Manual, **Assisted** (plan + approval gate), **Agent** (autonomous
  Plan → Search → Inspect → Retrieve → Extract → Verify → Synthesize → Complete loop), and
  **Advanced-Agent** (configurable per-run step/page/tool-call limits).
- **Secure read-only local file search** — allow-listed roots only; every read is path-checked and
  anything outside the allow-list is refused (`403`). Nothing is writable.
  Routes: `GET /v1/localfs`, `POST|DELETE /v1/localfs/roots`, `POST /v1/localfs/search`,
  `GET /v1/localfs/file`. New module `src/core/localfs.js`.
- **MCP Manager** — the MCP panel gains Servers, Profiles, Import and Templates tabs on top of the
  existing Tools and Config tabs:
  - register / toggle / **test** / remove external MCP servers,
  - **8 built-in starter profiles** (save & apply bundles of servers),
  - **JSON import** with validation, **secret-masked preview** and required-env flagging,
  - **15 starter server templates** (one-click add).
  Routes: `GET|POST /v1/mcp/servers`, `DELETE /v1/mcp/servers/:id`,
  `POST /v1/mcp/servers/:id/toggle|test`, `GET /v1/mcp/templates`,
  `GET|POST /v1/mcp/profiles`, `POST /v1/mcp/profiles/:id/apply`, `DELETE /v1/mcp/profiles/:id`,
  `POST /v1/mcp/import`. New module `src/core/mcp-servers.js`.
- **Agent execution engine** — `src/core/agent.js` with `GET /v1/agent/meta`, `POST /v1/agent`,
  `GET /v1/agent/:id`. Assisted mode returns a plan with `awaitingApproval: true`.
- **Results workspace tabs** — Answer · Sources · Data · Raw · Files · Agent Activity · Tool Calls
  · Logs, each with full provenance (tool, source, time, result).
- **Saved workspaces** — sessions become workspaces you can open / rerun / **duplicate** / **export**
  (`webcrawl.workspace.v1` bundle) / compare, with patchable tags & notes.
  Routes: `GET /v1/workspaces`, `POST /v1/workspaces/:id`,
  `POST /v1/workspaces/:id/duplicate`, `GET /v1/workspaces/:id/export`.
  New module `src/core/workspaces.js`.
- **Theme toggle** — vibrant dark / clean light, persisted in the browser.
- **Tests** — new regression suites: `test/localfs.test.js`, `test/mcp-servers.test.js`,
  `test/agent.test.js`, `test/workspaces.test.js` (26 tests total pass with `node --test`).

### Security

- Agent is **read-only by default**. Write / destructive MCP tools are opt-in (`allowWrite`) and
  gated by an approval policy (destructive actions require explicit approval).
- Fetched/scraped page content stays fenced as **untrusted input** and never reaches the planner as
  instructions (existing prompt-injection guard, unchanged).
- Imported MCP secrets are stored server-side and never returned to the browser unmasked.

### Fixed

- `GET /v1/localfs` now awaits `getAllowlist()` (was serializing a pending Promise), so it returns
  the real roots array.

### Unchanged (verified)

- Firecrawl-parity HTTP API (scrape / crawl / map / search / extract) and the WebUI Advanced-Mode
  panels.
- The stdio MCP server and its **six** tools (`smoke-test.mjs` still lists all six).
- Runtime-switchable LLM (Anthropic / OpenAI-compatible / LM Studio / Ollama / llama.cpp) and the
  `/v1/llm` routes.
- Keyless web search; dependency-free JSON persistence; no new runtime dependencies added.
