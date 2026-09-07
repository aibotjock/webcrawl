# webcrawl — Feature Inventory & Parity Contract

This document is the **zero-function-loss contract** for the unified-workspace rebuild.
Everything listed here existed before the rebuild and **must keep working** (additively).
The rebuild adds new capabilities on top; it does not remove or degrade anything below.

Legend: ✅ preserved unchanged · ➕ extended (back-compatible) · 🆕 added by the rebuild.

## 1. HTTP API routes (`src/server.js`)

| Method | Route | Status | Notes |
|--------|-------|--------|-------|
| POST | `/v1/scrape` | ✅ | URL → markdown/html/rawHtml/links/screenshot |
| POST | `/v1/map` | ✅ | site URL discovery |
| POST | `/v1/search` | ✅ | keyless DuckDuckGo search |
| POST | `/v1/extract` | ✅ | URL + schema → structured JSON (LLM or heuristic) |
| POST | `/v1/crawl` | ✅ | async crawl job (`wait` for sync) |
| GET | `/v1/crawl/:id` | ✅ | crawl job status |
| DELETE | `/v1/crawl/:id` | ✅ | advisory cancel |
| GET | `/v1/test` | ✅ | module health + chromium + llm reachability |
| POST | `/v1/research` | ✅ | intent-first research job (async) |
| GET | `/v1/research/:id` | ✅ | poll research job (`?since=` for cheap deltas) |
| GET | `/v1/research/:id/stream` | ✅ | SSE stage stream |
| POST | `/v1/research/schema` | ✅ | plain-English → JSON schema |
| GET | `/v1/sessions` | ✅ | list saved sessions |
| GET | `/v1/sessions/compare` | ✅ | compare two sessions |
| GET | `/v1/sessions/:id` | ✅ | full session |
| POST | `/v1/sessions/:id/rerun` | ✅ | rerun a saved session |
| GET | `/v1/mcp` | ✅ | MCP bootstrap (tools+hosts+defaults) |
| GET | `/v1/mcp/tools` | ✅ | MCP tool enable/disable state |
| POST | `/v1/mcp/tools` | ✅ | toggle MCP tools |
| GET | `/v1/mcp/config` | ✅ | generate a host client config |
| GET | `/v1/llm` | ✅ | current LLM settings + presets |
| POST | `/v1/llm` | ✅ | apply LLM settings live |
| GET | `/v1/llm/models` | ✅ | list endpoint model ids |
| GET | `/v1/localfs` | 🆕 | list approved allowlist roots |
| POST | `/v1/localfs/roots` | 🆕 | add an allowlisted root (read-only) |
| DELETE | `/v1/localfs/roots` | 🆕 | remove an allowlisted root |
| POST | `/v1/localfs/search` | 🆕 | search filenames + contents within allowlist |
| GET | `/v1/localfs/file` | 🆕 | read one allowlisted file (read-only) |
| GET | `/v1/mcp/servers` | 🆕 | list MCP servers (registry) |
| POST | `/v1/mcp/servers` | 🆕 | add/update an MCP server |
| DELETE | `/v1/mcp/servers/:id` | 🆕 | remove an MCP server |
| POST | `/v1/mcp/servers/:id/toggle` | 🆕 | enable/disable one server |
| POST | `/v1/mcp/servers/enable-all` | 🆕 | enable/disable all servers |
| POST | `/v1/mcp/servers/:id/test` | 🆕 | test-connection (static validation) |
| POST | `/v1/mcp/import` | 🆕 | parse+validate+preview pasted MCP JSON |
| GET | `/v1/mcp/templates` | 🆕 | starter MCP server templates |
| GET | `/v1/mcp/profiles` | 🆕 | list MCP profiles |
| POST | `/v1/mcp/profiles` | 🆕 | create/save a profile |
| POST | `/v1/mcp/profiles/:id/apply` | 🆕 | apply a profile (enable its servers) |
| DELETE | `/v1/mcp/profiles/:id` | 🆕 | remove a profile |
| POST | `/v1/agent` | 🆕 | run the agentic pipeline (modes+limits+routing) |
| GET | `/v1/agent/:id` | 🆕 | poll an agent run |
| GET | `/v1/workspaces` | 🆕 | list workspaces (superset of sessions) |
| GET | `/v1/workspaces/:id` | 🆕 | full workspace |
| POST | `/v1/workspaces/:id/duplicate` | 🆕 | duplicate a workspace |
| GET | `/v1/workspaces/:id/export` | 🆕 | export a workspace as JSON |

## 2. MCP stdio server (`src/mcp.js`) — 6 tools ✅ (unchanged, backward-compatible)

`webcrawl_scrape`, `webcrawl_crawl`, `webcrawl_map`, `webcrawl_search`, `webcrawl_extract`, `webcrawl_screenshot`.
Enable/disable persisted in `data/mcp-settings.json`, honored at startup.

## 3. Core engines (`src/core/`)

| Module | Status | Purpose |
|--------|--------|---------|
| `scrape.js` | ✅ | fetch/browser scrape → markdown (+ `fetchMethod` provenance) |
| `crawl.js` | ✅ | same-origin BFS crawl |
| `search.js` | ✅ | keyless DuckDuckGo search |
| `map.js` | ✅ | site URL discovery |
| `extract.js` | ✅ | schema extraction (LLM/heuristic) |
| `fetch.js` | ✅ | HTTP fetch + href helpers |
| `browser.js` | ✅ | Playwright headless chromium |
| `markdown.js` | ✅ | HTML → markdown |
| `config.js` | ✅ | server config (port/concurrency/timeouts) |
| `llm.js` | ✅ | selectable providers (anthropic/openai/cloud/lmstudio/ollama/llamacpp) |
| `research.js` | ➕ | intent-first planner + `runResearch` (now source-aware via agent) |
| `sessions.js` | ✅ | JSON-file session store (`data/sessions/`) |
| `mcp-config.js` | ✅ | MCP tool metadata + client-config builders |
| `localfs.js` | 🆕 | allowlisted, read-only local filesystem search |
| `mcp-servers.js` | 🆕 | MCP server registry + profiles + import/validate + templates |
| `agent.js` | 🆕 | agentic execution (modes/limits/routing) over the core engines |
| `workspaces.js` | 🆕 | workspaces layer (duplicate/export) over sessions |

## 4. WebUI controls (`webui/index.html`) — all preserved

Simple (intent-first) mode ✅, Advanced mode with direct Scrape/Search/Crawl/Map/Extract panels ✅,
Model panel ✅, Sessions drawer ✅, History ✅, Module Health ✅, in-WebUI MCP tool panel ✅.

🆕 added: theme toggle (vibrant dark + clean light), multi-source selector, research-domain +
depth presets, agent-mode selector + limits, MCP Manager (servers/profiles/import/templates),
results workspace tabs (Answer/Sources/Data/Raw/Files/Agent Activity/Tool Calls/Logs),
saved-workspace actions (duplicate/export), local-filesystem panel.

## 5. Persisted settings / runtime state (all git-ignored under `data/`)

| Key | Status | File |
|-----|--------|------|
| MCP tool enable/disable | ✅ | `data/mcp-settings.json` |
| Saved research sessions | ✅ | `data/sessions/*.json` |
| LLM settings | ✅ | in-memory (seeded from env), patched via `POST /v1/llm` |
| MCP server registry | 🆕 | `data/mcp-servers.json` |
| MCP profiles | 🆕 | `data/mcp-profiles.json` |
| Local-FS allowlist | 🆕 | `data/localfs-allowlist.json` |
| Theme preference | 🆕 | browser `localStorage` |

## 6. Security invariants (must never regress)

1. Local filesystem access is **read-only** and **strictly confined to the approved allowlist**;
   path traversal is rejected server-side.
2. Scraped/retrieved/imported content is **untrusted** — fenced before reaching any LLM; it can
   never alter the plan, permissions, or tool set (prompt-injection defense).
3. No real secrets are committed or echoed; MCP import/config use `sk-ant-...`-style placeholders.
4. Destructive / write-capable actions require explicit approval (agent write tools are opt-in).
5. The app runs fully offline of Abacus: local LLM or user key, keyless search — no cloud dependency.
