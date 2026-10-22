# webcrawl

Free, self-hosted search and crawling. One Node process gives you:

- **search** — Exa-style search that reads the pages for you: several sources fused, top pages fetched, passages ranked by meaning (TypeSafe Jev when configured), four speed levels, cited answers, search-by-photo
- **scrape** — URL to clean Markdown / HTML / links / screenshot (headless chromium for JS pages)
- **crawl** — recursive same-origin site walk
- **map** — every URL on a domain, fast, no sitemap required
- **extract** — unstructured page to strict typed JSON from a schema (any LLM, no CSS selectors)
- **HTTP API** (Firecrawl-parity `/v1/*` routes **and** Exa-compatible `/search`, `/contents`, `/findSimilar`, `/answer`) + **MCP server** (Claude Code, LM Studio, Hermes) + **WebUI**

```bash
npm install
npx playwright install chromium
npm start          # HTTP API + WebUI on :8787
npm run mcp        # stdio MCP server
```

## Search

```
sources (DuckDuckGo, Wikipedia, + SearXNG / Brave / Exa when configured)
   → reciprocal rank fusion → fetch top pages (cached) → passages
   → rank: Jev graded relevance + BM25 (+ embeddings) → results with highlights
```

| Level | What it does | Typical time |
| --- | --- | --- |
| `instant` | Searches pages already in the cache (the private index). No network. | < 0.3 s |
| `fast` | Asks every source, ranks titles and snippets. No page fetches. | ~1 s |
| `standard` (default) | Fetches the top 20 pages, ranks their passages, returns the best ones as highlights. | ~3–8 s |
| `deep` | An LLM writes sub-queries, in-site links are followed one hop, then standard ranking; optional cited answer or schema-shaped JSON. Needs an LLM; otherwise runs standard and says so. | ~15–60 s |

Extras on any level: `includeDomains` / `excludeDomains` (subdomains and path prefixes), `startPublishedDate` / `endPublishedDate` (pages with no detectable date are kept and flagged), `maxAgeHours` (cache reuse: `0` always fetch, `-1` cache only), `text`, `highlights`, `visual` (Jev reads screenshots of the leading pages, for answers living in charts or images).

**Search with a photo** (`POST /findByImage`, MCP `webcrawl_find_by_image`): finds candidate pages, pulls their product images, and asks Jev (or any vision LLM) whether each shows the same item as the photo. Exa has no photo-input search.

**Exa compatibility:** point an Exa client's base URL at this server. `type` maps to levels (`lite`→instant, `fast`/`instant`→fast, `auto`/`neural`→standard, `deep*`→deep); `contents.text`, `contents.highlights`, `contents.summary`, `livecrawl` and `outputSchema` are honored. Responses add a `webcrawl` block with the level, sources, ranking method, cache use and notes.

**Cost:** everything is free except Jev (TypeSafe bills $0.042 per million input tokens, output free) and any keyed sources or cloud LLM you add. A standard search with Jev sends about 100 passages; each response reports its Jev cost in `costDollars`.

### Configuration

| Variable | Purpose |
| --- | --- |
| `TYPESAFE_API_KEY` | Turns on Jev ranking. Without it, ranking is BM25 (+ embeddings if set). |
| `JEV_MODEL` | Default `jev-1.14.0`. Pin a version; scores shift between releases. |
| `WEBCRAWL_JEV_IMAGES=on` | Allows Jev image calls (photo search, `visual`). Uses TypeSafe's experimental `TypeSafe-Danger-Zone-Images` header. |
| `TYPESAFE_BASE_URL` | Default `https://api.typesafe.ai`. |
| `WEBCRAWL_LLM_PROVIDER` | `openai` (default: any OpenAI-compatible server — LM Studio, Ollama, vLLM, OpenAI, OpenRouter, Groq…), `anthropic` or `gemini`. Used by deep, answers, summaries, extract and the no-Jev photo fallback. |
| `WEBCRAWL_LLM_BASE_URL` / `WEBCRAWL_LLM_MODEL` / `WEBCRAWL_LLM_API_KEY` | Endpoint, model and key. Gemini needs `WEBCRAWL_LLM_MODEL`. |
| `WEBCRAWL_EMBED_BASE_URL` / `WEBCRAWL_EMBED_MODEL` / `WEBCRAWL_EMBED_API_KEY` | Optional OpenAI-compatible `/embeddings` endpoint blended into model-free ranking. |
| `WEBCRAWL_SEARCH_PROVIDERS` | Comma list to restrict sources, e.g. `searxng,brave`. Default: every configured one. |
| `SEARXNG_URL` | Self-hosted SearXNG with `json` in `search.formats`. |
| `BRAVE_API_KEY` | Brave Search API. |
| `EXA_API_KEY` | Uses Exa as one more source (and for `npm run bench:search -- --exa`). |
| `WEBCRAWL_CACHE_DIR` / `WEBCRAWL_CACHE_MAX` | Page cache folder (default `.cache/pages`, `off` for memory only) and size (default 5000). |
| `WEBCRAWL_API_KEY` | Requires `x-api-key` or `Authorization: Bearer` on every API route. Set this before exposing the server. |

### MCP tools

`webcrawl_search`, `webcrawl_answer`, `webcrawl_find_similar`, `webcrawl_find_by_image`, plus `webcrawl_scrape`, `webcrawl_crawl`, `webcrawl_map`, `webcrawl_extract`, `webcrawl_screenshot`.

```bash
claude mcp add webcrawl -e TYPESAFE_API_KEY=... -- node /path/to/webcrawl/src/mcp.js
```

### Measuring quality

`npm run bench:search -- testset-search.json --levels fast,standard,deep --exa` scores each level (and Exa, with `EXA_API_KEY`) on a labeled query set: nDCG@10, precision@5, recall@10, latency and cost per query. Add your own queries with `relevant` / `highly` URL prefixes.

`npm test` runs the offline unit tests; `npm run test:live` runs the network scrape tests.

See PROGRESS.html for the original build log.

License: MIT (original clean-room implementation; no Firecrawl code copied).
