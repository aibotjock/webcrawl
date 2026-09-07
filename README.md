# webcrawl

Free, self-hosted Firecrawl alternative. One binary-ish Node process gives you:

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

## AI model (local or cloud)

`extract` turns a page into typed JSON using an LLM (with a heuristic fallback when no LLM is
reachable). The LLM is **OpenAI-compatible and switchable at runtime** — run it against a local
model or a cloud endpoint, and flip between them live from the WebUI without restarting.

**From the WebUI:** click **Model** in the top bar. Pick a provider preset, set the base URL /
model / API key, hit **Test Connection** or **Fetch** (to list the endpoint's models), then
**Save & Apply**. The API key is stored server-side and never returned to the browser.

**From env** (`.env`, seeds the initial state — see `.env.example`):

| Variable | Meaning | Example |
|----------|---------|---------|
| `WEBCRAWL_LLM_PROVIDER` | `lmstudio` \| `ollama` \| `llamacpp` \| `openai` \| `cloud` | `ollama` |
| `WEBCRAWL_LLM_BASE_URL` | OpenAI-compatible base URL (ends in `/v1`) | `http://127.0.0.1:11434/v1` |
| `WEBCRAWL_LLM_MODEL` | model id | `llama3.1` |
| `WEBCRAWL_LLM_API_KEY` | Bearer key — **cloud only** (omit for local) | `sk-...` |

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

Full registration steps for each host and ready-to-edit config templates are in
[`mcp/README.md`](./mcp/README.md).

---

## Deploy

Systemd unit + nginx vhost templates live in [`deploy/`](./deploy/) (reverse proxy to the
Node process, iframe-embeddable, cache-revalidating). Copy `.env.example` to `.env`, point the
LLM vars at your model, symlink the unit/vhost into `/etc/`, `systemctl enable --now webcrawl`,
and reload nginx.

See PROGRESS.html for live status.
