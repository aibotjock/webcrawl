# webcrawl

Free, self-hosted Firecrawl alternative. One binary-ish Node process gives you:

- **research** *(new)* — describe a goal in plain language; an LLM planner sequences search → scrape → crawl → map → extract and synthesizes a cited answer, report or dataset. This is the default **Simple Mode** of the WebUI.
- **scrape** — URL to clean Markdown / HTML / links / screenshot (headless chromium for JS pages)
- **crawl** — recursive same-origin site walk
- **map** — every URL on a domain, fast, no sitemap required
- **search** — keyless live web search
- **extract** — unstructured page to strict typed JSON from a schema (local **or** cloud LLM, no CSS selectors)
- **HTTP API** (Firecrawl-parity routes) + **MCP server** (Claude Code, LM Studio, Hermes) + **WebUI**

```bash
npm install
npx playwright install chromium
cp .env.example .env   # optional — configure the AI model (see below)
npm start              # HTTP API + WebUI on :8787
npm run mcp            # stdio MCP server
```

License: MIT (original clean-room implementation; no Firecrawl code copied).

---

## Research (Simple Mode)

The WebUI opens in **Simple Mode** — an intent-first research interface. You type *what you want
to find out* in plain language, pick a few knobs, and hit **Run Research**. Behind the scenes an
LLM **planner** turns your goal into a plan and the engine sequences the existing core tools
(**search → scrape → crawl → map → extract**) automatically, then synthesizes the result.

**Knobs**

| Control | Options | Meaning |
|---|---|---|
| **Sources** | Entire web · Specific domains · Specific URLs | scope of what gets gathered |
| **Depth** | Quick (1 query · ~4 pages) · Standard (3 · ~10) · Deep (5 · ~24 + crawl) | how hard to look |
| **Output** | Answer · Report · Dataset · Raw Markdown · Structured Data | what you get back |
| **Max pages** | number | hard cap on pages fetched |

For **Dataset / Structured Data** output you describe the fields you want in **plain English**
(e.g. *"company name, funding amount, founding year"*) and the planner generates a JSON schema for
you — no manual schema authoring. (The manual-schema Extract panel still lives in Advanced Mode.)

**Live execution & results.** A staged progress view (Planning → Searching → Sources Found →
Scraping → Extracting → Verifying → Complete) streams while the run executes. Results land in four
tabs: **Answer** (synthesized, with citations), **Sources** (full provenance — URL, title,
retrieval time, discovery query, fetch method `fetch`/`browser`, HTTP status, success/failure),
**Raw Data** (per-source Markdown) and **Activity** (the step-by-step log).

**Advanced Mode.** Toggle **Advanced** in the top bar for the original tool-first panels
(Scrape / Crawl / Search / Map / Extract) — nothing was removed.

**Saved sessions.** Every run is persisted as a JSON file under `data/sessions/` (no external
DB). Open the **Sessions** drawer to reopen, **rerun**, or **compare** two runs (shared vs unique
sources + headline stats). Storage is dependency-free so the deployment just works.

**Safety — scraped content is untrusted.** All fetched page content is treated as **untrusted
input**. It is delimited/fenced before being shown to the LLM, and the planner only ever sees your
trusted prompt — never raw page text — so a malicious page cannot rewrite the research plan
(prompt-injection guard). If the LLM is unreachable the planner and schema generator fall back to
deterministic heuristics rather than failing.

### Research API

Additive routes — the Firecrawl-parity API and MCP tools are unchanged.

| Method / route | Purpose |
|---|---|
| `POST /v1/research` | start a run: `{ prompt, sources?, depth?, output?, maxPages?, extractPrompt?, schema? }` → `{ success, id }` |
| `GET /v1/research/:id?since=N` | poll status: `{ status, stage, stages[], result?, sessionId? }` (`since` skips already-seen stages) |
| `GET /v1/research/:id/stream` | same progress as Server-Sent Events |
| `POST /v1/research/schema` | plain-English → JSON schema: `{ description }` → `{ schema, source }` |
| `GET /v1/sessions` | list saved sessions (summaries, newest first) |
| `GET /v1/sessions/:id` | full saved session |
| `POST /v1/sessions/:id/rerun` | re-run a saved session's request → `{ id, rerunOf }` |
| `GET /v1/sessions/compare?a=&b=` | diff two sessions (shared/unique sources + stats + answers) |

```bash
# start a run
ID=$(curl -s -X POST localhost:8787/v1/research -H 'content-type: application/json' \
  -d '{"prompt":"compare the top self-hosted web scrapers","depth":"standard","output":"report"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
# poll until status == "completed"
curl -s "localhost:8787/v1/research/$ID" | python3 -m json.tool
```

---

## AI model (local or cloud)

`extract` turns a page into typed JSON using an LLM (with a heuristic fallback when no LLM is
reachable). The LLM is **switchable at runtime** — run it against a local model, an
OpenAI-compatible cloud endpoint, or **Anthropic Claude** (native `/v1/messages` API), and flip
between them live from the WebUI without restarting. Anthropic requests/responses are translated
transparently, so `extract` and the `/v1/llm` routes behave identically across providers.

**Default provider: Anthropic Claude** (`claude-3-5-sonnet-latest`). Set `ANTHROPIC_API_KEY` to
use it out of the box, or pick another provider in the WebUI / `.env`. If Anthropic is selected
without a key, nothing crashes — `extract` degrades to its heuristic mode and the WebUI shows a
note telling you to add a key or switch providers.

**From the WebUI:** click **Model** in the top bar. Pick a provider preset, set the base URL /
model / API key, hit **Test Connection** or **Fetch** (to list the endpoint's models), then
**Save & Apply**. The API key is stored server-side and never returned to the browser.

**From env** (`.env`, seeds the initial state — see `.env.example`):

| Variable | Meaning | Example |
|----------|---------|---------|
| `WEBCRAWL_LLM_PROVIDER` | `anthropic` (default) \| `openai` \| `cloud` \| `lmstudio` \| `ollama` \| `llamacpp` | `anthropic` |
| `WEBCRAWL_LLM_BASE_URL` | base URL ending in `/v1` (`https://api.anthropic.com/v1` for Claude) | `https://api.anthropic.com/v1` |
| `WEBCRAWL_LLM_MODEL` | model id | `claude-3-5-sonnet-latest` |
| `WEBCRAWL_LLM_API_KEY` | key — **cloud only** (Bearer, or `x-api-key` for Anthropic; omit for local) | `sk-...` |
| `ANTHROPIC_API_KEY` | fallback key used when `provider=anthropic` and `WEBCRAWL_LLM_API_KEY` is unset | `sk-ant-...` |

**Local examples**

```bash
# Ollama          (ollama serve; ollama pull llama3.1)
WEBCRAWL_LLM_PROVIDER=ollama   WEBCRAWL_LLM_BASE_URL=http://127.0.0.1:11434/v1 WEBCRAWL_LLM_MODEL=llama3.1
# LM Studio       (start its local server)
WEBCRAWL_LLM_PROVIDER=lmstudio WEBCRAWL_LLM_BASE_URL=http://127.0.0.1:1234/v1  WEBCRAWL_LLM_MODEL=<loaded-model>
```

**Cloud example (any OpenAI-compatible endpoint)**

```bash
WEBCRAWL_LLM_PROVIDER=openai WEBCRAWL_LLM_BASE_URL=https://api.openai.com/v1 \
WEBCRAWL_LLM_MODEL=gpt-4o-mini WEBCRAWL_LLM_API_KEY=sk-...
```

**Anthropic Claude example** (native `/v1/messages` API — not OpenAI-compatible)

```bash
WEBCRAWL_LLM_PROVIDER=anthropic WEBCRAWL_LLM_BASE_URL=https://api.anthropic.com/v1 \
WEBCRAWL_LLM_MODEL=claude-3-5-sonnet-latest ANTHROPIC_API_KEY=sk-ant-...
```

**LLM control endpoints**

| Method / route | Purpose |
|---|---|
| `GET /v1/llm` | current provider, base URL, model, `hasKey`, presets, reachability (key never returned) |
| `POST /v1/llm` | `{ provider?, baseUrl?, model?, apiKey? }` — apply live |
| `GET /v1/llm/models` | model ids advertised by the configured endpoint |
| `GET /v1/test` | module + chromium + llm health |

---

## MCP server

webcrawl is also an **MCP server** exposing `scrape`, `crawl`, `map`, `search`, `extract` and
`screenshot` as tools over stdio — usable from a terminal or any MCP host (Claude Desktop,
Claude Code, Cursor, VS Code / Continue, Windsurf, …).

```bash
npm run mcp                 # or: node src/mcp.js  ·  npx webcrawl-mcp
node mcp/generate-configs.mjs   # writes host configs with this checkout's path filled in
node mcp/smoke-test.mjs         # verify: lists the 6 tools
```

**Manage it from the WebUI:** click **MCP** in the top bar to enable/disable individual
tools (persisted server-side and honored by the stdio server at startup — a disabled tool
isn't registered) and to generate a ready-to-paste client config for Claude Desktop, Cursor,
Windsurf, VS Code or Continue. The config is built live with this checkout's absolute path
filled in; you can tweak the node command, server-script path and LLM env, then copy or
download it. Keyed providers show an `sk-ant-...` placeholder (your real key is never emitted).

Full registration steps for each host and ready-to-edit config templates are in
[`mcp/README.md`](./mcp/README.md).

---

## Deploy

Systemd unit + nginx vhost templates live in [`deploy/`](./deploy/) (reverse proxy to the
Node process, iframe-embeddable, cache-revalidating). Copy `.env.example` to `.env`, point the
LLM vars at your model, symlink the unit/vhost into `/etc/`, `systemctl enable --now webcrawl`,
and reload nginx.

See PROGRESS.html for live status.
