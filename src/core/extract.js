// Structured extraction: scrape -> markdown -> LLM (OpenAI-compatible) or label/table heuristics.
import { config } from './config.js';

async function getMarkdown(url, _mdFn) {
  if (_mdFn) return _mdFn(url);
  const { scrape } = await import('./scrape.js');
  return scrape(url, { formats: ['markdown'] });
}
async function llmUp() {
  try { return (await fetch(`${config.llmBaseUrl}/models`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

function parseJson(text) {
  if (!text) return undefined;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  for (const [a, b] of [['{', '}'], ['[', ']']]) {
    const s = t.indexOf(a), e = t.lastIndexOf(b);
    if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  }
  return undefined;
}

// Minimal JSON-schema conformance: types, required, enum, array items, additionalProperties===false pruning, numeric-string coercion.
function conform(v, s, path = '$', errs = []) {
  if (!s || typeof s !== 'object') return v;
  if (Array.isArray(s.enum) && !s.enum.some((x) => JSON.stringify(x) === JSON.stringify(v))) errs.push(`${path}: ${JSON.stringify(v)} not in enum`);
  const t = s.type;
  if (t === 'number' || t === 'integer') {
    let n = v;
    if (typeof n === 'string') { const p = Number(n.replace(/[$,\s]/g, '')); if (n.trim() !== '' && Number.isFinite(p)) n = p; }
    if (!Number.isFinite(n) || typeof n !== 'number' || (t === 'integer' && !Number.isInteger(n))) {
      errs.push(`${path}: expected ${t}, got ${JSON.stringify(v)?.slice(0, 60)}`);
      return v;
    }
    return n;
  }
  if (t === 'boolean') { if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true'; if (typeof v !== 'boolean') errs.push(`${path}: expected boolean, got ${JSON.stringify(v)?.slice(0, 60)}`); return v; }
  if (t === 'string') { if (typeof v !== 'string') errs.push(`${path}: expected string, got ${JSON.stringify(v)?.slice(0, 60)}`); return v; }
  if (t === 'array') {
    if (!Array.isArray(v)) { errs.push(`${path}: expected array, got ${JSON.stringify(v)?.slice(0, 60)}`); return v; }
    return v.map((x, i) => conform(x, s.items || {}, `${path}[${i}]`, errs));
  }
  if (t === 'object') {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) { errs.push(`${path}: expected object, got ${JSON.stringify(v)?.slice(0, 60)}`); return v; }
    for (const k of s.required || []) if (v[k] === undefined || v[k] === null || v[k] === '') errs.push(`${path}.${k}: required property missing`);
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (s.properties && k in s.properties) out[k] = conform(val, s.properties[k], `${path}.${k}`, errs);
      else if (s.additionalProperties === false) continue; // pruned
      else out[k] = val;
    }
    return out;
  }
  return v;
}
const validate = (data, schema) => { const errs = [], value = conform(data, schema, '$', errs); return { ok: !errs.length, value, errs }; };

async function rawChat(body) {
  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  return { status: res.status, j: await res.json().catch(() => ({})) };
}
async function complete(messages, { maxTokens = 4096, jsonMode = true } = {}) {
  const body = { model: config.llmModel, temperature: 0, max_tokens: maxTokens, messages };
  if (jsonMode) body.response_format = { type: 'json_object' };
  let { status, j } = await rawChat(body);
  if (status === 400 && jsonMode && /response_format/i.test(JSON.stringify(j))) { delete body.response_format; ({ status, j } = await rawChat(body)); }
  if (status >= 400) throw new Error(`llm http ${status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.choices?.[0]?.message || {};
}
async function extractViaLlm(schema, md, prompt) {
  const sys = 'You are a precise data-extraction engine. Respond with ONLY a JSON value strictly conforming to the JSON schema provided in the user message. No markdown, no code fences, no commentary, no trailing text — the entire reply must be parseable JSON.';
  const user = `JSON schema:\n${JSON.stringify(schema)}\n${prompt ? `\nExtraction instructions: ${prompt}\n` : ''}\nPage content (markdown):\n${md}`;
  let note = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const suffix = attempt === 0 ? '\n/no_think' : '';
    const messages = [
      { role: 'system', content: sys + suffix },
      { role: 'user', content: user + (note ? `\n\nYour previous reply was invalid: ${note}\nReturn the corrected JSON only.` : '') },
    ];
    let msg = await complete(messages, { maxTokens: 4096 });
    let text = String(msg.content || '').trim();
    if (!text && msg.reasoning_content) { // reasoning model burned the budget: retry with more tokens and thinking allowed
      const m2 = await complete(messages.map((m, i) => (i === 0 ? { role: 'system', content: sys } : m)), { maxTokens: 8192 });
      text = String(m2.content || '').trim();
    }
    const data = parseJson(text);
    if (data === undefined) { note = `reply was not valid JSON: ${text.slice(0, 160)}`; continue; }
    const v = validate(data, schema);
    if (v.ok) return v.value;
    note = `schema validation failed: ${v.errs.join('; ')}`;
  }
  throw new Error(`llm extraction failed after retry: ${note}`);
}

// ---- heuristic mode ----
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
function mdTables(md) {
  const lines = md.split('\n'), out = [];
  const cells = (l) => l.trim().replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i]) || i + 1 >= lines.length || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    const head = cells(lines[i]);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) rows.push(cells(lines[j]));
    out.push({ head, rows });
    i = j - 1;
  }
  return out;
}
function labelValue(md, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[_\s-]+/g, '[\\s_-]*').replace(/([a-z])([A-Z])/g, '$1[\\s_]*$2');
  const inline = md.match(new RegExp(`^#{0,6}\\s*[-*>]*\\s*\\**${esc}\\**\\s*[:\\-—]\\s*(.+?)\\s*$`, 'im'));
  if (inline) return inline[1].replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
  const lines = md.split('\n').map((l) => l.trim());
  const head = new RegExp(`^#{1,6}\\s+\\**${esc}\\**\\s*:?$`, 'i');
  const bold = new RegExp(`^\\**${esc}\\**$`, 'i');
  for (let i = 0; i < lines.length; i++)
    if (head.test(lines[i]) || bold.test(lines[i]))
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++)
        if (lines[j]) return lines[j].replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
  return null;
}
const numFrom = (t) => { const m = String(t || '').replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
function priceNear(md, name) {
  const lines = md.split('\n').filter((l) => l.toLowerCase().includes(name.toLowerCase()));
  for (const l of lines) { const n = numFrom(l); if (n !== null) return n; }
  return null;
}
function tableRows(md, itemSchema) {
  const props = Object.entries(itemSchema.properties || {});
  if (!props.length) return [];
  for (const tbl of mdTables(md)) {
    const cols = {};
    for (const [p] of props) { const h = tbl.head.find((h) => { const a = norm(h), b = norm(p); return a === b || (a.length > 2 && (a.includes(b) || b.includes(a))); }); if (h) cols[h] = p; }
    let keys = Object.values(cols);
    if (!keys.length && tbl.head.length === props.length) { tbl.head.forEach((h, i) => (cols[h] = props[i][0])); keys = tbl.head.map((h) => cols[h]); }
    if (!keys.length) continue;
    const rows = [];
    for (const r of tbl.rows) {
      const o = {};
      tbl.head.forEach((h, i) => { if (cols[h] === undefined || r[i] === undefined) return; const ps = itemSchema.properties[cols[h]]; o[cols[h]] = ps?.type === 'number' || ps?.type === 'integer' ? numFrom(r[i]) : r[i]?.replace(/\*\*/g, '').trim(); });
      if (Object.values(o).some((x) => x !== null && x !== undefined && x !== '')) rows.push(o);
    }
    if (rows.length) return rows;
  }
  return [];
}
function propValue(md, name, ps) {
  const raw = labelValue(md, name);
  if (ps?.type === 'number' || ps?.type === 'integer') return raw !== null && numFrom(raw) !== null ? numFrom(raw) : priceNear(md, name);
  if (ps?.type === 'boolean') { const r = (raw || '').toLowerCase(); return /\b(yes|true|in stock|available)\b/.test(r) ? true : /\b(no|false|out of stock|unavailable)\b/.test(r) ? false : undefined; }
  if (ps?.type === 'array') { if (ps.items?.properties) { const rows = tableRows(md, ps.items); return rows.length ? rows : undefined; } return undefined; }
  if (ps?.type === 'object' || ps?.properties) { const o = heuristic(md, ps); return Object.keys(o).length ? o : undefined; }
  if (name.toLowerCase() === 'title' && !raw) { const h = md.match(/^#\s+(.+)$/m); return (h || md.match(/^\s*(\S.*)$/))[1].trim(); }
  return raw;
}
function heuristic(md, schema) {
  const out = {};
  if (schema?.type === 'array' && schema.items?.properties) { const rows = tableRows(md, schema.items); return rows; }
  for (const [name, ps] of Object.entries(schema?.properties || {})) {
    const v = propValue(md, name, ps);
    if (v !== undefined && v !== null && v !== '') out[name] = v;
  }
  return out;
}

export async function extract(url, schema, { prompt, limitTokens = 6000, _mdFn } = {}) {
  const t0 = Date.now();
  const reply = (data, mode, error) => ({ data, mode, latencyMs: Date.now() - t0, ...(error ? { error } : {}) });
  try {
    const r = await getMarkdown(url, _mdFn);
    const md = String(r?.markdown || '').slice(0, limitTokens * 4);
    if (!md) return reply(null, 'heuristic', r?.metadata?.error || `no markdown from ${url}`);
    if (await llmUp()) {
      try { return reply(await extractViaLlm(schema, md, prompt), 'llm'); }
      catch (e) { const v = validate(heuristic(md, schema), schema); return reply(v.value, 'heuristic', v.ok ? undefined : `${e?.message || e}; heuristic fallback invalid: ${v.errs.join('; ')}`); }
    }
    const v = validate(heuristic(md, schema), schema);
    return reply(v.value, 'heuristic', v.ok ? undefined : `heuristic: ${v.errs.join('; ')}`);
  } catch (e) {
    return reply(null, 'heuristic', String(e?.message || e));
  }
}
