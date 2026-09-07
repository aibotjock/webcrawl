# webcrawl MCP server

webcrawl ships a **stdio MCP server** (`src/mcp.js`, also exposed as the `webcrawl-mcp` bin)
so any MCP host can call webcrawl's tools directly from the terminal or an editor:

| Tool | What it does |
|------|--------------|
| `webcrawl_scrape` | URL → markdown / html / rawHtml / links / screenshot |
| `webcrawl_crawl` | same-origin BFS crawl, markdown per page |
| `webcrawl_map` | fast URL discovery (sitemap + link graph) |
| `webcrawl_search` | keyless web search |
| `webcrawl_extract` | page → strict typed JSON from a schema (local **or** cloud LLM) |
| `webcrawl_screenshot` | PNG as a `data:image/png;base64` URI |

> **Note:** the WebUI's new intent-first **Research (Simple Mode)** — the automatic
> search→scrape→crawl→map→extract planner and saved sessions — is exposed over the **HTTP API**
> (`/v1/research`, `/v1/sessions`; see the root [README](../README.md#research-simple-mode)) and
> the WebUI. The MCP surface is **unchanged and fully backward-compatible** — still exactly the
> six tools above. Compose them yourself from an MCP host, or call the HTTP `/v1/research` route
> for the one-shot planned pipeline.

## Manage it from the WebUI (no files to hand-edit)

The WebUI has an **MCP** panel (top bar, next to *Sessions*) that does everything below
from the browser:

- **Enable/disable tools** with a toggle per tool. The choice is **persisted server-side**
  (in `data/mcp-settings.json`, git-ignored) and is **honored by `src/mcp.js` at startup** —
  a disabled tool is simply not registered, so the next time a host launches the server it
  won't advertise it. The top-bar badge shows how many of the six tools are exposed.
- **Generate a client config** for Claude Desktop / Cursor / Windsurf / VS Code / Continue:
  pick a host and the JSON is built live with **this checkout's absolute `src/mcp.js` path**
  already filled in. You can customise the **node command/binary path**, the **server script
  path**, and the **LLM env** (provider / base URL / model / API key). **Copy** to the
  clipboard or **Download** the file.
- API keys are never round-tripped: the generated JSON shows a `sk-ant-...` **placeholder**
  for keyed providers (you fill in your own), and local providers (LM Studio / Ollama /
  llama.cpp) get no key line at all.

The same data is available over HTTP if you'd rather script it:
`GET /v1/mcp` (tools + hosts + defaults), `GET /v1/mcp/tools`,
`POST /v1/mcp/tools` (`{name,enabled}` or `{disabled:[...]}`),
`GET /v1/mcp/config?host=&command=&serverPath=&provider=&baseUrl=&model=&apiKey=`.

### Managing *external* MCP servers *(new)*

The MCP panel is now a full **manager** for external MCP servers (in addition to the six
built-in tools and the config generator above). From the browser you can:

- **Servers** — register external MCP servers, toggle them on/off, **test** connectivity, and
  remove them. Enabled servers can act as tools during agentic research runs.
- **Profiles** — save/apply named bundles of servers; **8 built-in starter profiles** ship in.
- **Import** — paste MCP server JSON; it is **validated**, **previewed with secret env values
  masked**, and required env vars are flagged before you save it.
- **Templates** — **15 starter server templates** you can add in one click.

Scriptable over HTTP:
`GET/POST /v1/mcp/servers`, `DELETE /v1/mcp/servers/:id`,
`POST /v1/mcp/servers/:id/toggle`, `POST /v1/mcp/servers/:id/test`,
`GET /v1/mcp/templates`, `GET/POST /v1/mcp/profiles`,
`POST /v1/mcp/profiles/:id/apply`, `DELETE /v1/mcp/profiles/:id`,
`POST /v1/mcp/import` (returns `{ preview }` to validate, then `{ saved, servers }` to persist).
Server and template records use a `name` field. Imported secrets are stored server-side and
never returned to the browser unmasked.

The CLI generator below is still available and shares the exact same config-building logic
(`src/core/mcp-config.js`) as the WebUI, so both produce identical output.

`webcrawl_extract` uses the same runtime-switchable LLM as the WebUI (see the root
[README](../README.md#ai-model-local-or-cloud)). The default provider is **Anthropic
Claude** (native `/v1/messages` API) — just set `ANTHROPIC_API_KEY` in the `env` block. You can
also point it at a local model (Ollama / LM Studio / llama.cpp — no key) or a cloud
OpenAI-compatible endpoint. Anthropic env example:
`WEBCRAWL_LLM_PROVIDER=anthropic`, `WEBCRAWL_LLM_BASE_URL=https://api.anthropic.com/v1`,
`WEBCRAWL_LLM_MODEL=claude-3-5-sonnet-latest`, `ANTHROPIC_API_KEY=sk-ant-...`.

## Run it from a terminal

```bash
npm install
npx playwright install chromium
npm run mcp                 # or:  node src/mcp.js  ·  or:  npx webcrawl-mcp
```

It speaks JSON-RPC on **stdout** (diagnostics go to stderr). MCP hosts launch this
command for you — you normally don't run it by hand except to smoke-test it.

## Register it with a host

Generate configs with **this checkout's absolute path** already filled in:

```bash
node mcp/generate-configs.mjs
# writes mcp/generated/{claude_desktop_config,cursor.mcp,windsurf_mcp_config,vscode_mcp,continue_config}.json
```

To have the MCP server use a **cloud** model for `webcrawl_extract`, set env before generating:

```bash
WEBCRAWL_LLM_PROVIDER=cloud \
WEBCRAWL_LLM_BASE_URL=https://api.openai.com/v1 \
WEBCRAWL_LLM_MODEL=gpt-4o-mini \
WEBCRAWL_LLM_API_KEY=sk-... \
node mcp/generate-configs.mjs
```

Ready-to-edit templates (replace `/ABSOLUTE/PATH/TO/webcrawl`) live in [`clients/`](./clients/).

### Claude Desktop
Edit the config file, then fully restart Claude Desktop:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Merge the contents of `clients/claude_desktop_config.json` into `mcpServers`.

### Claude Code (CLI)
```bash
claude mcp add webcrawl -- node /ABSOLUTE/PATH/TO/webcrawl/src/mcp.js
```

### Cursor
Project scope: create `.cursor/mcp.json` in your repo (or global `~/.cursor/mcp.json`)
with the contents of `clients/cursor.mcp.json`. Enable it in **Settings → MCP**.

### Windsurf
Edit `~/.codeium/windsurf/mcp_config.json` (or **Settings → Cascade → MCP → Manage**)
using `clients/windsurf_mcp_config.json`.

### VS Code
- **GitHub Copilot (Agent mode):** save `clients/vscode_mcp.json` as `.vscode/mcp.json`
  in your workspace, or add its `servers` block to user `settings.json` under `"mcp"`.
- **Continue extension:** merge `clients/vscode_continue.json` into `~/.continue/config.json`.

### Any other MCP host
Use the stdio command directly:
```
command: node
args:    ["/ABSOLUTE/PATH/TO/webcrawl/src/mcp.js"]
```

## Verify

```bash
node mcp/smoke-test.mjs     # initializes the server and lists the 6 tools
```
