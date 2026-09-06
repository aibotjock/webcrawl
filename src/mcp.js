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
    description: 'Keyless web search (DuckDuckGo); returns [{ title, url, description }].',
    schema: z.object({ query: z.string().min(1), limit: posInt }),
    run: (a) => import('./core/search.js').then((m) => m.webSearch(a.query, { limit: a.limit })),
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
      [k, k === 'markdown' && typeof x === 'string' && x.length > 200e3
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
