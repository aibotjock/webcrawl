# webcrawl

Free, self-hosted Firecrawl alternative. One binary-ish Node process gives you:

- **scrape** — URL to clean Markdown / HTML / links / screenshot (headless chromium for JS pages)
- **crawl** — recursive same-origin site walk
- **map** — every URL on a domain, fast, no sitemap required
- **search** — keyless live web search
- **extract** — unstructured page to strict typed JSON from a schema (local LLM, no CSS selectors)
- **HTTP API** (Firecrawl-parity routes) + **MCP server** (Claude Code, LM Studio, Hermes) + **WebUI**

```bash
npm install
npx playwright install chromium
npm start          # HTTP API + WebUI on :8787
npm run mcp        # stdio MCP server
```

Full docs land as the gauntlet rounds close. See PROGRESS.html for live status.

License: MIT (original clean-room implementation; no Firecrawl code copied).
