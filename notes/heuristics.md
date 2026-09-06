# Clean-Room Behavioral Spec: Firecrawl-compatible scrape/map/crawl/search/extract

Written from behavioral study of the AGPL reference implementation (clone at
/data/aibotjock/firecrawl) plus 10 captured live-cloud outputs in
/data/aibotjock/webcrawl/bar_cache/scrape/. No code was copied; everything below
is a functional description. Provenance file:line refs are repo-relative.

---

## 1. SCRAPE PIPELINE (URL -> final markdown)

Order (apps/api/src/scraper/scrapeURL/index.ts):

1. Build per-scrape "meta": hostname-keyed URL-specific option overrides
   (www stripped), forced engines for special sites, abort timers from
   `timeout`, URL classification by extension (.pdf/.doc-family/image/.html)
   into feature flags. Uploaded files go to temp as "prefetch" payloads.
2. Optional enterprise threat-protection check (skip when reimplementing).
3. robots.txt check when enabled: fetch robots.txt (reuse crawl's cached
   copy); disallowed URL -> denial error. Fetch failure -> ALLOW (fail-open).
   Never check robots for /robots.txt itself.
4. Engine waterfall (section 3): ordered engines raced; first good result
   wins and aborts the rest.
5. Postprocessors keyed on final URL (e.g. YouTube transcript substitution).
6. Assemble Document: engine markdown/pages/blocks/rawHtml/screenshot/
   actions/json + metadata {sourceURL, url (final), statusCode, error,
   numPages/totalPages/title (PDFs), contentType, timezone, proxyUsed
   ("basic"|"stealth"), cacheState ("hit"/"miss"), cachedAt,
   postprocessorsUsed}.
7. Transformer stack, fixed order (transformers/index.ts `transformerStack`):
   clean-HTML-from-rawHtml -> markdown -> cleanContent -> redactPII -> links
   -> images -> branding -> metadata -> product -> menu -> (index write) ->
   LLM extract -> deterministicJson -> summary -> query -> attributes ->
   agent -> removeBase64Images -> diff -> audio -> video -> coerce fields.

Engine success test (index.ts:648-793): status 2xx/304 AND converted content
non-empty; non-2xx results still count as results; no-page-error also passes.
401/403/429 + proxy=auto -> add stealth-proxy flag and retry the waterfall.
HTML >300 KB skips the quality-check markdown conversion (raw length used).
Empty onlyMainContent output -> re-convert with onlyMainContent=false (at both
engine-check and transformer level) and use the fallback.

### HTML cleaning before markdown (scrapeURL/lib/removeUnwantedElements.ts)

Primary impl is a native (Rust) transform; JS fallback behaves as:

- `includeTags` (CSS selectors): non-empty -> build a NEW document holding
  only clones of matches (everything else discarded).
- Always removed, every mode: script, style, noscript, meta, head.
- `excludeTags` (CSS selectors): matches removed. A `*...*`-wrapped pattern
  is a case-insensitive REGEX over tag names and `attr="value"` strings;
  `*.` prefix restricts it to the class attribute.
- `onlyMainContent: true` (DEFAULT) additionally removes header/footer/nav/
  aside elements plus class/id matches: header, top, navbar, footer, bottom,
  sidebar, side, aside, modal, popup, overlay, ad, ads, advert,
  lang-selector, language, language-selector, social, social-media,
  social-links, menu, navigation, nav, breadcrumbs, share, widget, cookie —
  EXCEPT elements containing force-include selectors (#main, CMS-specific
  list). Match is on the element itself, so nav built from plain divs with
  unmatched classes SURVIVES (BBC capture retains full site nav).
- NOT removed by default: iframe, inline svg (HN logo renders as a link to
  its .svg), form/input, tables (HN output is entirely GFM layout tables),
  cookie banners without a matching class/id.
- Images: `srcset` collapsed to the SINGLE largest candidate (numeric
  descriptor, trailing unit stripped; all-"x" descriptors + plain `src` ->
  src counts as 1x; winner written into `src`). Then img src and a href are
  absolutized against the page URL; unparseable values left silently.
- Links are NOT pruned, deduped, or rewritten beyond absolutization; query
  strings and fragments preserved.

### Markdown conversion (lib/html-to-markdown.ts)

Three interchangeable converters behind one function: HTTP microservice, a
Go shared library, or fallback Turndown + Joplin GFM plugin (tables,
strikethrough, task lists) plus one custom anchor rule emitting
`[trimmed text](href "title")` followed by a newline. Every converter output
then runs through a native post-processor (`postProcessMarkdown`) that
normalizes whitespace/escapes — the source of the uniform cloud style.

Special content types (transformers/index.ts:139-160): JSON responses become
the raw body inside a ```json fence; text/plain (llms.txt) passes through
UNTOUCHED (HTML conversion corrupts underscores in URLs); only these bypass
conversion.

Markdown derived only when a format needs it: markdown, changeTracking,
json, summary, question, highlights, query, redactPII, onlyCleanContent.
Engine-native markdown short-circuits derivation.

### example.com capture => normalizer behavior

`# Example Domain`, blank line, cleaned body paragraphs (trailing whitespace
stripped), blank line, `[Learn more](https://iana.org/domains/example)` —
absolute href, no title, no stray emphasis. Heading levels preserved as-is.

Provenance 1: scrapeURL/index.ts:648-793,1148-1203;
removeUnwantedElements.ts:9-214; html-to-markdown.ts:54-185;
transformers/index.ts ~99-195,~649-672; bar_cache example-com,
news-ycombinator, www-bbc-com-news JSONs.

---

## 2. MARKDOWN STYLE (source rules + 10 live captures)

- Bullets: `-`. Ordered lists keep literal numbering (`1.` `2.`).
- Emphasis: strong -> `**`, em -> `_` (underscore form); adjacent runs can
  yield doubled-underscore artifacts. Page-styled separators appear bold
  (`**·**` mid-dots on Wikipedia).
- Links: inline always; `[text](absoluteURL)`, title attr appended as
  `[text](url "Title")` (python.org, Wikipedia). Text trimmed; image-wrapped
  links become `[![alt](img)](href)`. Never reference-style, never dropped.
- Images: `![alt](absoluteURL)` inline; srcset collapsed to largest (sec 1);
  data: URIs stripped after (removeBase64Images default true).
- Tables: GFM pipe tables incl. pure layout tables (HN); empty headers as
  `|     |     |` + `| --- | --- |`; in-cell pipes escaped `\|`.
- Code: triple-backtick fences, language often absent (react.dev). `<br>`
  becomes `\` + LF (hard break) — pervasive in BBC/GitHub captures.
- Headings: HTML levels preserved verbatim (h3 stays `###`); permalink
  anchor link text stays inside the heading line (react.dev).
- Escaping: pipes and plain-text underscores backslash-escaped; URL query
  strings left intact.
- Blank lines: exactly one between block elements; list items with multiple
  block children separated by 2+ blank lines, content indented 4 spaces
  (books.toscrape product cards).
- Line wrapping: NONE — paragraphs are single physical lines.
- Skip-to-content links SURVIVE cloud output (GitHub/BBC/python.org) even
  though a remover exists in source — dead code on the live path; match it.
- Deep-list blank-line runs preserved, not collapsed (books capture).

Provenance 2: html-to-markdown.ts:122-185; removeBase64Images default at
controllers/v2/types.ts:806; all bar_cache/scrape/*.json `result.markdown`.

---

## 3. JS-RENDER DECISION (static vs headless)

No per-URL JS sniffing — an engine waterfall ordered by quality
(engines/index.ts:80-102, 639-1064):

- Index/cache engine first (quality 1000) — zero-network stored markdown
  when eligible: no custom headers, no actions, maxAge != 0, no
  changeTracking/branding, no custom screenshot viewport/quality, not parse.
- Hostname specials: x-twitter API (1500); Wikipedia Enterprise API (500,
  50% sampling on wikimedia URLs).
- Headless Chrome via CDP (50), retry variant (45), stealth variants
  (negative; pulled in when stealth requested/auto-escalated), HTTP-client
  impersonation "tlsclient" (10), Playwright (20), plain undici fetch (5);
  file parsers (pdf/docx/image) at the tail.
- Hosted deployment drops plain fetch/tlsclient from the general list
  (bot-walled junk). Self-hosted (no fire-engine) effective chain:
  index -> playwright -> plain fetch -> pdf/docx.
- Mechanics: engine N starts; after maxReasonableTime(N) + fixed delay,
  engine N+1 starts WITHOUT canceling N; first success aborts losers. Plain
  fetch MRT 15s. Whole-scrape cap 5 min; `timeout` default 30s (v1), 60s
  with json/changeTracking, 120s with stealth/enhanced/auto proxy.
- A static fetch returning empty/short markdown for a JS site just LOSES the
  race; the browser engine takes over. That is the entire "decision".
- waitFor: int ms 0..60000, default 0 (flag absent at 0); waitFor <=
  timeout/2; total wait (waitFor + wait actions) capped by a constant.
- Screenshots: format object {type:"screenshot", fullPage?, quality? 0-100,
  format? png|jpeg|webp, viewport? {width,height}}; one screenshot format
  max; fullPage = whole page vs viewport; custom viewport/quality disables
  the index shortcut; returned base64 in `screenshot`; needs CDP engine.
- Browser-forcing features: actions (click/press/scroll/write/wait/
  screenshot/scrape/pdf/javascript), audio/video, branding. mobile (false
  default) switches UA/viewport; blockAds (true) enables ad blocking;
  skipTlsVerification defaults TRUE unless headers/actions present.

Provenance 3: engines/index.ts:80-102,240-607,609-637,639-1064;
engines/fetch/index.ts:231-233; scrapeURL/index.ts:876-954;
controllers/v2/types.ts:795-834,852-908.

---

## 4. MAP ALGORITHM (URL discovery)

(lib/map-utils.ts getMapResults; v1 twin in controllers/v1/map.ts)

1. Resolve input-URL redirects; if final hostname differs, graft it onto the
   original URL.
2. Fetch robots.txt once (gates sitemap); failure non-fatal.
3. Parallel sources: (a) crawl index — domain-level + URL-split-level
   queries for bare domains (domain-wide when includeSubdomains, default
   true), deduped; (b) search-engine map service with `site:{url}` — or
   `{search} site:{url-without-www}` given `search`, `{search} {url}` when
   allowExternalLinks — 100 results/page, page 1 first (stop if empty),
   remaining pages concurrently, capped at min(100, limit); raw results
   Redis-cached 48h keyed by query.
4. sitemap: "only" -> sitemap exclusively (limit 10M); "include" -> merged
   with index+search; default -> none. v1 flags: ignoreSitemap (false),
   sitemapOnly.
5. Merge: with `search`, search results BEFORE index results; else after.
   Cap at min(100000, limit) pre-ranking.
6. With `search`, rank by cheap cosine similarity query-vs-URL-string
   (word counts normalized by text length — not embeddings; map-cosine.ts).
7. Post-filter: normalize URLs (query params STRIPPED by default —
   ignoreQueryParameters true; trim; drop unparseable), same-domain only
   (same-subdomain if !includeSubdomains), and when the input has a real
   path + filterByPath + !allowExternalLinks keep only paths starting with
   the input path prefix.
8. Dedupe by exact normalized URL (titled entry beats untitled); slice to
   limit.

Response: v1 {success, links: string[], scrape_id?}; internals add job_id,
time_taken (seconds). Latency = parallel index+search fan-out + 48h cache;
sitemap bounded by 30s timeout.

Provenance 4: map-utils.ts:82-368; map-cosine.ts:49-95; controllers/v1/
map.ts:59-375,560-573; MAX_MAP_LIMIT=100000 (controllers/v1/types.ts:982);
search service call search/fireEngine.ts:70-90.

---

## 5. CRAWL DEFAULTS

- maxDepth 10, counted in path segments relative to the start URL's depth;
  index.php/index.html segments don't count (WebScraper/utils/
  maxDepthUtils.ts). maxDiscoveryDepth bounds discovery separately.
- limit (max pages) 10000.
- includePaths/excludePaths (v1 alias includes/excludes): Rust-regex
  (RE2-style) on the percent-encoded URL path; NO globs/lookahead/
  backreferences/Unicode classes; invalid patterns rejected at request time;
  max 100 patterns/field, 2000 chars each (lib/crawl-regex.ts).
- allowBackwardCrawling (allowBackwardLinks) false — no walking UP the path
  tree. allowExternalLinks false (implied true with enableWebSearch).
- includeSubdomains true (map opts); ignoreSitemap false.
- Discovery: links from cleaned absolutized HTML + optional sitemap;
  normalized then deduped in the crawl's seen-set; robots fetched once per
  crawl and enforced per URL.
- Execution: POST creates a job; pages scrape under a per-team semaphore —
  DEFAULT 2 concurrent scrapes/team (lib/concurrency-limit.ts:24).
- Status shape: {status: "scraping"|"completed"|"cancelled"|"failed",
  completed, total, creditsUsed, expiresAt, data: Document[]}, partial data
  while running. Per-page options inherit /v1/scrape defaults.

Provenance 5: controllers/v1/types.ts:876-886,919-952,994-995,1420-1478;
crawl-regex.ts:1-75; concurrency-limit.ts:24,37; controllers/v1/crawl.ts:
280-304; crawl-status.ts:208-246; maxDepthUtils.ts:1-16.

---

## 6. SEARCH

- Backend chain (src/search/v2/index.ts): hosted fire-engine search
  microservice, else SearXNG, else direct DuckDuckGo HTML scraping — one
  shared contract.
- Query: domain filters folded into the string (includeDomains/
  excludeDomains), optional tbs, lang "en", country "us", location, safe,
  type ("web"; v2 adds "news"/"images"; exclusive "developer" category from
  a separate index).
- Overfetch 2x limit, then slice each group to limit.
- v1 response: {success:true, data:[{url,title,description}], warning?} —
  warning on zero results or zero scraped pages with content. v2 groups
  {web,news,images} of {title,url,description,position,category?}.
- scrapeOptions with formats -> each result scraped under concurrency;
  merged doc replaces the plain entry; empty-content docs filtered with a
  warning.
- Billing heuristic: ceil(total/10)*2 credits (x5 under ZDR). Failure ->
  500 {success:false, error}.

Provenance 6: search/v2/index.ts:17-60; search/execute.ts:87-243;
controllers/v1/search.ts:230-349.

---

## 7. EXTRACT (prompt/LLM loop)

A) scrape formats ["extract"|"json"] (transformers/llmExtract.ts): skipped
   if the engine natively produced JSON. Model by schema shape — $ref/$defs/
   definitions (recursive) -> large-context model; simple/none -> small fast
   model. Token ceilings from a model price table (fallback 8192 in / 4096
   out). Loop: prompt = page markdown + user prompt + serialized schema ->
   generateObject -> Ajv validation -> bounded retry with backoff on invalid
   output; LLM refusal aborts with a distinct refusal error. Output in
   document.json / document.extract.

B) /v1/extract (lib/extract/*, controllers/v1/extract.ts): <=10 URLs,
   natural-language prompt, optional JSON schema/systemPrompt/
   enableWebSearch. Async job (id + status URL immediately).
   - An LLM reframes the prompt into a short keyword search query
     (optimizer persona; ~3 words); with the schema it builds a one-sentence
     relevance target.
   - Candidates from map + optional web search; reranked by relevance with
     caps: 1000 initial -> 100 relevance-scored, tiny thresholds, min 1 link
     (lib/extract/config.ts).
   - A schema-analyzer prompt classifies single-answer vs multi-entity
     (array keys across pages) to pick the aggregation strategy.
   - Top pages scraped; markdown deduped/merged under a 4096-token budget,
     fed with schema to the LLM; validation + retries as in (A).
   - Terminal: {success, data:<schema-shaped>, error?, status} + token
     usage; failures as {success:false, error}.

Provenance 7: transformers/llmExtract.ts:1-120; lib/extract/config.ts:1-11;
lib/extract/build-prompts.ts (prompts paraphrased, not quoted);
controllers/v1/extract.ts (async pattern).

---

## 8. API SHAPES (exact field names)

POST /v1/scrape {url} -> 200 {success:true, ...document at top level:
markdown, html, rawHtml, links, screenshot, json/extract, actions, warning?,
metadata:{sourceURL, url, statusCode, error, contentType, proxyUsed,
cacheState?, cachedAt?, title?, description?, language?, keywords?, robots?,
favicon?, ogTitle?, ogDescription?, ogUrl?, ogImage?, scrapeId, creditsUsed,
concurrencyLimited}}. Errors {success:false, code, error}: DNS -> HTTP 200
with success:false; timeout -> 408; validation -> 400; unsafe-domain ->
403.

POST /v1/crawl {url, scrapeOptions?, crawlerOptions? (includes, excludes,
maxDepth, limit, allowBackwardLinks, ignoreSitemap), webhook?} -> 200
{success:true, id, url:"<origin>/v1/crawl/<id>"}. GET /v1/crawl/:id ->
{status, completed, total, creditsUsed, expiresAt, data[]}. DELETE cancels.

POST /v1/map {url, search?, limit?, includeSubdomains, sitemap?
("include"|"only"|v1 ignoreSitemap), ignoreQueryParameters?} -> 200
{success:true, links: string[]}. Cap 100000 (v2), request default 5000.

POST /v1/search {query, limit?, tbs?, filter?, lang?, country?, location?,
safe?, scrapeOptions?} -> 200 {success:true, data:[{url,title,description,
...scrape fields?}], warning?}.

POST /v1/extract {urls: string[<=10], prompt, schema?, systemPrompt?,
enableWebSearch?, showDetails?} -> {success, id, url}; GET /v1/extract/:id ->
{success, status, data, error?}.

Parity-critical scrape defaults: formats ["markdown"], onlyMainContent true,
onlyCleanContent false, waitFor 0, timeout 30000 (v1), mobile false,
blockAds true, proxy "auto", removeBase64Images true, storeInCache true,
skipTlsVerification true (false with headers/actions).

Provenance 8: controllers/v1/scrape.ts:70-370; crawl.ts:280-304;
crawl-status.ts:208-246; map.ts:355-375,560-573; search.ts:230-349;
v1/types.ts:726-834,991-1013; v2/types.ts:726-834; bar_cache metadata.

---

## 9. TOKEN-EFFICIENCY TRICKS

- Boilerplate removed BEFORE conversion (onlyMainContent default; script/
  style/head always stripped) shrinks LLM-facing markdown.
- removeBase64Images default true — data-URIs never reach output.
- Cache-first engine: index hits skip network + conversion (cacheState/
  cachedAt; maxAge tunes freshness; storeInCache true). Map's search leg
  cached 48h; map index queries bounded by a 14-day recency window.
- Markdown derived only when a format needs it; engine-native markdown
  short-circuits; >300 KB HTML skips the redundant quality conversion.
- Speculative engine overlap: next engine starts while the previous still
  runs (MRT + delay) — latency ~= accepted engine, not the sum.
- Search overfetches 2x then slices; no-scrape v1 search returns only
  {url,title,description}.
- Extract funnel: 1000 -> 100 candidates; merged context dedup capped 4096
  tokens; small model unless the schema is recursive.
- Hostname short circuits (Wikipedia API, x/twitter API); text/plain and
  JSON bodies bypass HTML conversion.
- URL normalization before storage/dedup (query stripped in map, trimmed,
  absolute) keeps caches dense and dedup cheap.

Provenance 9: scrapeURL/index.ts:646-731; engines/index.ts:609-637;
map-utils.ts:205-253; search/execute.ts:105; extract/config.ts;
transformers/index.ts:99-195; removeUnwantedElements.ts:9-51.

---

## Caveats

- Hosted cloud uses proprietary fire-engine + URL index; self-hosted chain
  is index -> playwright -> fetch (+pdf/docx). Parity hinges on the browser
  engine and the native post-processor's whitespace/escape normalization
  (compiled Rust lib in the reference) — replicate the OBSERVED style in
  section 2, not the library.
- Live outputs keep layout tables, skip-links, and unmatched nav divs — do
  not over-clean.
- The two markdown post-helpers in lib/html-to-markdown.ts (multi-line link
  joining, skip-link removal) are NOT on the live path — outputs prove it.
