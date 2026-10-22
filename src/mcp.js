#!/usr/bin/env node
// webcrawl stdio MCP server (Claude Code / LM Studio / Hermes entrypoint).
// NOTHING but JSON-RPC on stdout — diagnostics go to stderr via console.error only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod'; // transitively available via @modelcontextprotocol/sdk

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const url = z.string().url().describe('absolute http(s) URL');
const viewport = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });
const posInt = z.number().int().positive().optional();

const tools = {
  webcrawl_scrape: {
    description: 'Scrape a single URL; returns markdown/html/rawHtml/links/screenshot per requested formats.',
    schema: z.object({
      url,
      formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot'])).optional()
        .describe("default ['markdown']"),
      onlyMainContent: z.boolean().optional(),
      timeout: z.number().positive().optional(),
      waitFor: z.number().positive().optional().describe('ms to wait after load'),
    }),
    run: (a) => import('./core/scrape.js').then((m) => m.scrape(a.url, a)),
  },
  webcrawl_crawl: {
    description: 'Crawl a site (same-origin BFS, glob filters) and return markdown per page.',
    schema: z.object({
      url, limit: posInt, maxDepth: posInt,
      includeGlobs: z.array(z.string()).optional(), excludeGlobs: z.array(z.string()).optional(),
    }),
    run: (a) => import('./core/crawl.js').then((m) => m.crawlSite(a.url, a)),
  },
  webcrawl_map: {
    description: 'Fast site URL discovery (sitemap + link graph) without scraping page content.',
    schema: z.object({ url, limit: posInt }),
    run: (a) => import('./core/map.js').then((m) => m.mapSite(a.url, a)),
  },
  webcrawl_search: {
    description: 'Web search that reads the pages for you. Levels: instant (pages already cached, no network), fast (titles/snippets from every source, ~1s), standard (default: fetches the top pages and returns the best passages as highlights, ~3-8s), deep (an LLM splits the question into sub-queries and follows in-site links, ~15-60s). Results are ranked by meaning (Jev when configured). Returns [{ url, title, publishedDate, score, highlights, text? }].',
    schema: z.object({
      query: z.string().min(1).describe('natural-language question or keywords'),
      level: z.enum(['instant', 'fast', 'standard', 'deep']).optional(),
      numResults: z.number().int().min(1).max(50).optional().describe('default 10'),
      limit: posInt.describe('alias of numResults'),
      includeDomains: z.array(z.string()).optional().describe('e.g. ["github.com", "docs.python.org/3"]'),
      excludeDomains: z.array(z.string()).optional(),
      startPublishedDate: z.string().optional().describe('ISO date; drops pages published earlier'),
      endPublishedDate: z.string().optional(),
      text: z.boolean().optional().describe('include each page as markdown'),
      maxAgeHours: z.number().int().optional().describe('reuse cached pages up to this age; 0 = always fetch fresh, -1 = cache only'),
      visual: z.boolean().optional().describe('also judge page screenshots (Jev images)'),
    }),
    run: (a) => import('./search/engine.js').then((m) => m.search(a.query, { ...a, numResults: a.numResults || a.limit, highlights: { highlightsPerUrl: 2 } })),
  },
  webcrawl_answer: {
    description: 'Search, read the best pages, and answer the question with numbered citations. Uses the configured LLM (any OpenAI-compatible, Anthropic or Gemini); without one it returns the top extracted passages. Pass outputSchema to get JSON matching a schema, with sources per field.',
    schema: z.object({
      query: z.string().min(1),
      level: z.enum(['standard', 'deep']).optional(),
      includeDomains: z.array(z.string()).optional(), excludeDomains: z.array(z.string()).optional(),
      outputSchema: z.record(z.string(), z.any()).optional(),
    }),
    run: (a) => import('./search/engine.js').then((m) => m.search(a.query, { ...a, numResults: 8, answer: true, highlights: true })),
  },
  webcrawl_find_similar: {
    description: 'Find pages similar to a given URL (on other sites by default).',
    schema: z.object({ url, numResults: z.number().int().min(1).max(50).optional(), excludeSourceDomain: z.boolean().optional() }),
    run: (a) => import('./search/engine.js').then((m) => m.findSimilar(a.url, { ...a, highlights: true })),
  },
  webcrawl_find_by_image: {
    description: 'Search with a photo: finds pages showing the same item (product, model, object) and checks their images against the photo with Jev or a vision LLM. Good for identifying an item or finding where it is sold.',
    schema: z.object({
      image: z.string().describe('image as http(s) URL, data: URI, or base64'),
      query: z.string().optional().describe('what the item is, if known; written from the photo by the LLM when omitted'),
      numResults: z.number().int().min(1).max(30).optional(),
      includeDomains: z.array(z.string()).optional().describe('e.g. ["ebay.com", "amazon.com"]'),
    }),
    run: (a) => import('./search/engine.js').then((m) => m.findByImage(a)),
  },
  webcrawl_extract: {
    description: 'Scrape a URL and extract structured JSON matching the given schema (local LLM, heuristic fallback).',
    schema: z.object({
      url,
      schema: z.record(z.string(), z.any()).describe('JSON schema describing the object to extract'),
      prompt: z.string().optional().describe('extra guidance for the extractor'),
    }),
    run: (a) => import('./core/extract.js').then((m) => m.extract(a.url, a.schema, { prompt: a.prompt })),
  },
  webcrawl_screenshot: {
    description: 'Screenshot a URL; returns PNG as a data:image/png;base64 URI.',
    schema: z.object({ url, fullPage: z.boolean().optional(), viewport: viewport.optional() }),
    run: (a) => import('./core/scrape.js').then((m) =>
      m.scrape(a.url, { formats: ['screenshot'], fullPage: a.fullPage, viewport: a.viewport })),
  },
};

// clip only markdown strings over 200k chars (leave base64 screenshots and everything else intact)
const clip = (v) => Array.isArray(v) ? v.map(clip)
  : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).map(([k, x]) =>
      [k, (k === 'markdown' || k === 'text') && typeof x === 'string' && x.length > 200e3
        ? x.slice(0, 200e3) + '\n[... truncated]' : clip(x)]))
    : v;

const server = new McpServer({ name: 'webcrawl', version }, { capabilities: { tools: {} } });
for (const [name, t] of Object.entries(tools)) {
  server.registerTool(name, { title: name, description: t.description, inputSchema: t.schema }, async (args) => {
    try {
      const result = await t.run(args);
      return { content: [{ type: 'text', text: JSON.stringify(clip(result), null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] };
    }
  });
}

await server.connect(new StdioServerTransport());
console.error(`webcrawl mcp v${version} ready on stdio (${Object.keys(tools).length} tools)`);
