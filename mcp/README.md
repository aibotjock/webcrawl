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
