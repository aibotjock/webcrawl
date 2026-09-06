# webcrawl core module contract (v1)

All modules are ESM (`"type":"module"`). Node >= 20. No TypeScript build step.
Minimize code; prefer fewer files and fewer deps (allowed: playwright, turndown,
@mozilla/readability, express, @modelcontextprotocol/sdk, node stdlib).

Config via env, read once in `src/core/config.js`:
- `PORT` (default 8787) — HTTP API + WebUI port
- `WEBCRAWL_LLM_BASE_URL` (default `http://127.0.0.1:1234/v1`) — OpenAI-compatible endpoint (LM Studio) for /extract
- `WEBCRAWL_LLM_MODEL` (default `local-model`) — model name for /extract
- `WEBCRAWL_CONCURRENCY` (default 8) — crawl/map fetch concurrency
- `WEBCRAWL_TIMEOUT_MS` (default 30000) — per-page timeout

## src/core/fetch.js
```js
fetchPage(url, { timeoutMs, headers }) -> { status, contentType, html, finalUrl, latencyMs, error? }
```
Plain HTTP fetch with redirects, browser-like UA, gzip. Never throws — returns `error`.

## src/core/browser.js
```js
withPage(url, fn, { timeoutMs, waitUntil, viewport }?) -> fn(page) result
renderPage(url, { timeoutMs, waitUntil, viewport }?) -> { status, html, finalUrl, latencyMs, error? }
screenshotPage(url, { fullPage, viewport, timeoutMs }?) -> { status, screenshotPath, finalUrl, latencyMs, error? }
```
Lazily-started shared chromium; hard timeout per page; close browser after idle (export `closeBrowser()`).

## src/core/markdown.js
```js
htmlToMarkdown(html, { baseUrl }?) -> { markdown, title, description }
extractMain(html, baseUrl) -> { contentHtml, title }   // boilerplate strip
```
Pure function of HTML. Turndown + custom rules. Must strip nav/footer/aside/script/style/cookie banners.

## src/core/scrape.js
```js
scrape(url, {
  formats = ['markdown'],        // subset of ['markdown','html','rawHtml','links','screenshot']
  onlyMainContent = true,
  timeout, waitFor, fullPage, viewport
}) -> {
  markdown?, html?, rawHtml?, links?, screenshot?,  // screenshot = data:image/png;base64
  metadata: { title, description, statusCode, url, error? }, latencyMs
}
```
Fetch static first; if content looks JS-shell (tiny/empty body, framework markers) or JS-only signals, re-render via browser. Screenshot format always uses browser.

## src/core/map.js
```js
mapSite(url, { limit = 200, timeout }) -> { urls: [string], count, latencyMs, source: { sitemap: n, links: n } }
```
Fast URL discovery WITHOUT full page scrape. Race/merge sitemap.xml + homepage link-graph expansion under a time budget. Same-origin only.

## src/core/crawl.js
```js
crawlSite(url, { limit = 50, maxDepth = 5, includeGlobs = [], excludeGlobs = [], concurrency }) ->
  { pages: [{ url, markdown, statusCode }], count, latencyMs }
```
BFS, same-origin by default, glob include/exclude, reuses scrape() per page (markdown only).

## src/core/search.js
```js
webSearch(query, { limit = 8 }) -> { results: [{ title, url, description }], latencyMs }
```
Keyless. DuckDuckGo HTML endpoint(s) with graceful fallbacks (html.duckduckgo.com/html/?q=, lite.duckduckgo.com/lite/?q=). Browser render fallback if blocked.

## src/core/extract.js
```js
extract(url, schema, { prompt, limitTokens }?) -> { data, mode: 'llm'|'heuristic', latencyMs, error? }
```
Scrape -> clean markdown -> if OpenAI-compatible LLM reachable, strict JSON-schema-constrained generation with validate-and-retry (1 retry). Else heuristic mode: pattern/table/label proximity extraction. NEVER returns schema-invalid JSON without `error`.

## src/server.js (express)
Firecrawl-parity REST + static webui:
- POST /v1/scrape  { url, formats, onlyMainContent, timeout, waitFor } 
- POST /v1/map     { url, limit }
- POST /v1/search  { query, limit }
- POST /v1/extract { url, schema, prompt }
- POST /v1/crawl   { url, limit, ... } -> starts job -> { id }; GET /v1/crawl/:id -> { status, data }
  (PLUS convenience sync mode: { url, wait: true } returns final result directly)
- GET /v1/test  -> live self-check
Serves webui/index.html at `/`.

## src/mcp.js (stdio MCP, @modelcontextprotocol/sdk)
Tools (same semantics as core): `webcrawl_scrape`, `webcrawl_crawl`, `webcrawl_map`, `webcrawl_search`, `webcrawl_extract`, `webcrawl_screenshot`. Single object arg per tool. Text results, JSON-stringified payloads. Must handshake cleanly with `claude mcp add`, LM Studio mcp.json, and any stdio MCP client.

## Error shape (everywhere)
`success: false, error: string, code?: string` — never throw across module boundaries.
