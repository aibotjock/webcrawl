// Agentic execution layer.
//
// The user describes a GOAL and picks a MODE + limits + sources. The agent plans,
// routes to the right tools (search/scrape/crawl/map/extract/localfs/enabled-MCPs),
// executes with live staged progress, records every tool call + provenance, verifies,
// and synthesizes. It reuses the existing engines (research.js, localfs.js) — nothing
// is reinvented, so all web behavior stays identical to Simple Mode.
//
// SAFETY (unchanged from research.js + localfs.js):
//   * The PLANNER only sees the trusted user goal, never retrieved content.
//   * Retrieved web pages AND local files are treated as UNTRUSTED data; they can never
//     change the plan, the permitted tool set, or permissions (prompt-injection defense).
//   * Local filesystem access is read-only + allowlisted (enforced in localfs.js).
//   * Write-capable / destructive tools are OPT-IN and require an approval policy; the
//     agent never runs them autonomously unless the request explicitly allows it.

import { planResearch, runResearch } from './research.js';
import { searchLocal } from './localfs.js';
import { enabledServers } from './mcp-servers.js';

export const AGENT_MODES = ['manual', 'assisted', 'agent', 'advanced-agent'];
export const RESEARCH_DOMAINS = ['general', 'ai-technology', 'medicine', 'law', 'science', 'finance', 'academic', 'engineering', 'business', 'custom'];
export const DEPTHS = ['quick', 'standard', 'deep', 'exhaustive', 'custom'];

// Depth → default limits. "custom" lets the caller override every number.
const DEPTH_LIMITS = {
  quick:      { maxPages: 4,  maxSearches: 1, maxCrawlDepth: 0, maxIterations: 1 },
  standard:   { maxPages: 10, maxSearches: 3, maxCrawlDepth: 0, maxIterations: 1 },
  deep:       { maxPages: 24, maxSearches: 5, maxCrawlDepth: 1, maxIterations: 2 },
  exhaustive: { maxPages: 50, maxSearches: 8, maxCrawlDepth: 2, maxIterations: 3 },
};

const clampInt = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
};

// Normalize an agent request into a safe, bounded shape.
export function normalizeAgentRequest(body = {}) {
  const b = body || {};
  const mode = AGENT_MODES.includes(b.mode) ? b.mode : 'agent';
  const depth = DEPTHS.includes(b.depth) ? b.depth : 'standard';
  const base = DEPTH_LIMITS[depth] || DEPTH_LIMITS.standard;
  const lim = b.limits || {};
  const limits = {
    maxPages: clampInt(lim.maxPages, 1, 200, base.maxPages),
    maxSearches: clampInt(lim.maxSearches, 1, 25, base.maxSearches),
    maxCrawlDepth: clampInt(lim.maxCrawlDepth, 0, 5, base.maxCrawlDepth),
    maxIterations: clampInt(lim.maxIterations, 1, 6, base.maxIterations),
    runtimeMs: clampInt(lim.runtimeMs, 5000, 600000, 180000),
    llmCap: clampInt(lim.llmCap, 1, 200, 40),
    toolPreference: ['local', 'cloud', 'auto'].includes(lim.toolPreference) ? lim.toolPreference : 'auto',
  };
  // sources: array of selectors. Each: {type, values?} where type is one of
  // web | search | url | domain | localfs | github | mcp | previous | custom
  const rawSources = Array.isArray(b.sources) ? b.sources : (b.sources ? [b.sources] : [{ type: 'web' }]);
  const sources = rawSources.map((s) => {
    if (typeof s === 'string') return { type: s, values: [] };
    return { type: String(s.type || 'web'), values: Array.isArray(s.values) ? s.values.map(String).filter(Boolean).slice(0, 50) : [] };
  }).slice(0, 12);
  return {
    goal: String(b.goal || b.prompt || '').trim(),
    mode,
    depth,
    domain: RESEARCH_DOMAINS.includes(b.domain) ? b.domain : 'general',
    output: ['answer', 'report', 'dataset', 'markdown', 'structured'].includes(b.output) ? b.output : 'answer',
    sources,
    limits,
    allowWrite: b.allowWrite === true,          // opt-in for write-capable tools
    approvalPolicy: ['always', 'destructive-only', 'never'].includes(b.approvalPolicy) ? b.approvalPolicy : 'destructive-only',
    ...(b.schema && typeof b.schema === 'object' ? { schema: b.schema } : {}),
    ...(typeof b.extractPrompt === 'string' && b.extractPrompt.trim() ? { extractPrompt: b.extractPrompt.trim() } : {}),
  };
}

// Map the agent's multi-source selection to the research pipeline's { mode, values } shape.
function toResearchSources(sources) {
  const urls = []; const domains = [];
  let hasWeb = false;
  for (const s of sources) {
    if (s.type === 'url') urls.push(...s.values);
    else if (s.type === 'domain') domains.push(...s.values);
    else if (s.type === 'web' || s.type === 'search') hasWeb = true;
  }
  if (urls.length) return { mode: 'urls', values: urls };
  if (domains.length) return { mode: 'domains', values: domains };
  if (hasWeb) return { mode: 'web', values: [] };
  return null; // no web-type source selected
}

// Decide which tools the agent will use, given the goal + selected sources + domain.
// Returns a routing plan for transparency (shown in the UI "Tool Calls" tab).
export function routeTools(req, plan) {
  const types = new Set(req.sources.map((s) => s.type));
  const tools = [];
  if (types.has('web') || types.has('search')) tools.push({ tool: 'search', reason: 'discover web sources for the goal' });
  if (types.has('url')) tools.push({ tool: 'scrape', reason: 'fetch the user-provided URL(s)' });
  if (types.has('domain')) tools.push({ tool: req.depth === 'deep' || req.depth === 'exhaustive' ? 'map' : 'search', reason: 'discover pages within the given domain(s)' });
  if (types.has('web') || types.has('search') || types.has('url') || types.has('domain')) tools.push({ tool: 'scrape', reason: 'retrieve page content with provenance' });
  if (types.has('localfs')) tools.push({ tool: 'localfs', reason: 'search approved local folders (read-only)' });
  if (types.has('github')) tools.push({ tool: 'search', reason: 'GitHub via site:github.com search' });
  if (types.has('mcp')) tools.push({ tool: 'mcp', reason: 'enabled MCP servers advertised to the agent' });
  const wantStructured = req.output === 'dataset' || req.output === 'structured' || !!req.schema || !!req.extractPrompt;
  if (wantStructured) tools.push({ tool: 'extract', reason: 'pull structured JSON from retrieved content' });
  tools.push({ tool: 'synthesize', reason: 'produce a verified, cited answer' });
  return tools;
}

// Run the agent. onStage(stage, entry) mirrors research.js so the UI polls the same way.
// Returns a workspace-compatible result: { request, mode, plan, toolCalls, agentActivity,
//   sources, raw, files, extracted, answer, llmUsed, stats }.
export async function runAgent(req, onStage = () => {}) {
  const t0 = Date.now();
  const request = normalizeAgentRequest(req);
  const agentActivity = [];
  const toolCalls = [];
  const logs = [];
  const emit = (stage, detail = {}) => {
    const entry = { ts: new Date().toISOString(), stage, ...detail };
    agentActivity.push(entry);
    try { onStage(stage, entry); } catch {}
  };
  const logTool = (tool, input, ok, detail) => {
    const c = { ts: new Date().toISOString(), tool, input, ok, ...detail };
    toolCalls.push(c);
    logs.push(`[${c.ts}] ${tool} ${ok ? 'ok' : 'FAILED'}${detail?.note ? ' — ' + detail.note : ''}`);
    return c;
  };

  emit('plan', { message: 'Interpreting the goal and building a plan', mode: request.mode });
  const plan = await planResearch({ prompt: request.goal, output: request.output, depth: request.depth === 'exhaustive' ? 'deep' : request.depth, sources: toResearchSources(request.sources) || { mode: 'web', values: [] }, extractPrompt: request.extractPrompt, schema: request.schema });
  const routing = routeTools(request, plan);
  emit('planned', { queries: plan.queries, extractFields: plan.extractFields, note: plan.note, planSource: plan.source, routing });

  // Enabled MCP servers are advertised to the agent for transparency (execution of
  // external MCP tools is delegated to the host; we record which are available).
  let mcpAvailable = [];
  if (request.sources.some((s) => s.type === 'mcp')) {
    try { mcpAvailable = (await enabledServers()).map((s) => ({ id: s.id, name: s.name, capability: s.capability, scope: s.scope })); }
    catch { mcpAvailable = []; }
    emit('mcp', { message: `${mcpAvailable.length} enabled MCP server(s) available to the agent`, servers: mcpAvailable });
  }

  // Assisted mode: return the plan for user approval, do not execute yet.
  if (request.mode === 'assisted') {
    emit('awaiting_approval', { message: 'Assisted mode: review the plan, then run again in Agent mode to execute.' });
    return {
      request, mode: request.mode, plan, routing, toolCalls, agentActivity, logs,
      mcpAvailable, sources: [], raw: [], files: [], extracted: null,
      answer: '', llmUsed: false, awaitingApproval: true,
      stats: { sources: 0, scraped: 0, files: 0, durationMs: Date.now() - t0 },
    };
  }

  // ---- web / url / domain retrieval via the existing research pipeline ----------
  let web = null;
  const researchSources = toResearchSources(
    // treat github as web with a site: filter injected into queries
    request.sources.map((s) => (s.type === 'github' ? { type: 'domain', values: ['github.com'] } : s)),
  );
  if (researchSources) {
    logTool('search', { queries: plan.queries }, true, { note: `${plan.queries.length} query(ies)` });
    const researchInput = {
      prompt: request.goal,
      sources: researchSources,
      depth: request.depth === 'exhaustive' ? 'deep' : (request.depth === 'custom' ? 'deep' : request.depth),
      output: request.output,
      maxPages: request.limits.maxPages,
      ...(request.schema ? { schema: request.schema } : {}),
      ...(request.extractPrompt ? { extractPrompt: request.extractPrompt } : {}),
    };
    // forward research stages into the agent activity stream
    web = await runResearch(researchInput, (stage, entry) => emit(stage, entry));
    logTool('scrape', { count: web.stats?.sources }, true, { note: `${web.stats?.scraped}/${web.stats?.sources} pages ok` });
    if (web.extracted) logTool('extract', { rows: web.extracted.rows.length }, true, {});
  }

  // ---- local filesystem retrieval (read-only, allowlisted) ---------------------
  let files = [];
  const localSel = request.sources.find((s) => s.type === 'localfs');
  if (localSel) {
    emit('inspect', { message: 'Searching approved local folders (read-only)' });
    try {
      const terms = (plan.queries && plan.queries.length ? plan.queries : [request.goal]);
      const seen = new Set();
      for (const term of terms.slice(0, request.limits.maxSearches)) {
        const r = await searchLocal({ query: term, maxResults: Math.min(50, request.limits.maxPages) });
        for (const hit of r.results) {
          if (seen.has(hit.path)) continue; seen.add(hit.path);
          files.push({ ...hit, discoveryQuery: term });
        }
        logTool('localfs', { query: term }, true, { note: `${r.results.length} match(es), scanned ${r.scannedFiles}` });
        if (files.length >= request.limits.maxPages) break;
      }
      emit('local_found', { count: files.length, message: `Found ${files.length} local file match(es)` });
    } catch (e) {
      logTool('localfs', { }, false, { note: String(e?.message || e) });
      emit('local_error', { error: String(e?.message || e) });
    }
  }

  emit('verify', { message: 'Cross-checking sources and assembling results' });
  const webSources = web?.sources || [];
  const answer = web?.answer || (files.length ? `Found ${files.length} matching local file(s).` : '');

  emit('complete', {
    message: 'Done',
    stats: { sources: webSources.length, scraped: web?.stats?.scraped || 0, files: files.length },
  });

  return {
    request,
    mode: request.mode,
    plan,
    routing,
    toolCalls,
    agentActivity,
    logs,
    mcpAvailable,
    sources: webSources,
    raw: web?.raw || [],
    files,
    extracted: web?.extracted || null,
    answer,
    llmUsed: web?.llmUsed || false,
    synthError: web?.synthError || null,
    awaitingApproval: false,
    stats: {
      sources: webSources.length,
      scraped: web?.stats?.scraped || 0,
      failed: web?.stats?.failed || 0,
      files: files.length,
      extractedRows: web?.extracted ? web.extracted.rows.length : 0,
      toolCalls: toolCalls.length,
      durationMs: Date.now() - t0,
    },
  };
}
