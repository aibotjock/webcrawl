// TypeSafe Jev client for search: graded passage relevance (text) and
// same-item photo matching (images, Jev 1.13+/1.14 "Danger Zone" image input).
//
// Env: TYPESAFE_API_KEY (turns Jev on), TYPESAFE_BASE_URL (default
// https://api.typesafe.ai), JEV_MODEL (default jev-1.14.0; pin a version,
// thresholds shift between releases), WEBCRAWL_JEV_IMAGES=on to allow image calls.
//
// API: POST /v1/systemone { model, state, questions, assets? } -> { answers, model, usage }.
// Images are declared once in `assets` and referenced by placeholder strings.
import { randomUUID } from 'node:crypto';

const env = (k) => String(process.env[k] || '').trim();
// Jev allows 64k tokens per request (32k per question incl. shared state). Stay well under.
export const MAX_REQUEST_TOKENS = 40000;
const PRICE_PER_INPUT_TOKEN = 0.042 / 1e6; // published rate; output tokens are free

export function jevConfig() {
  const apiKey = env('TYPESAFE_API_KEY');
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env('TYPESAFE_BASE_URL') || 'https://api.typesafe.ai').replace(/\/+$/, ''),
    model: env('JEV_MODEL') || 'jev-1.14.0',
    images: /^(1|on|true|yes)$/i.test(env('WEBCRAWL_JEV_IMAGES')),
    timeoutMs: Number(env('JEV_TIMEOUT_MS')) || 20000,
  };
}

const estimateTokens = (obj) => Math.ceil(JSON.stringify(obj).length / 4);
const words = (s, n) => { const w = String(s || '').replace(/\s+/g, ' ').trim().split(' '); return w.length > n ? w.slice(0, n).join(' ') + '…' : w.join(' '); };

async function post(cfg, body, { fetchImpl = globalThis.fetch, images = false, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${cfg.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
          ...(images && { 'TypeSafe-Danger-Zone-Images': 'true' }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (e) {
      if (attempt < retries) continue;
      throw new Error(`Jev request failed: ${e?.name === 'TimeoutError' ? 'timed out' : 'network error'}`);
    }
    const text = await res.text();
    if (res.ok) { try { return JSON.parse(text); } catch { throw new Error('Jev returned non-JSON'); } }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) continue;
    throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

// Splits questions into requests that each stay under the token budget, runs them in
// parallel, and merges answers + usage.
async function askAll(cfg, { state, questions, assets }, opts = {}) {
  const base = estimateTokens({ model: cfg.model, state });
  const groups = [[]];
  let size = base;
  for (const entry of Object.entries(questions)) {
    const t = estimateTokens(entry);
    if (size + t > MAX_REQUEST_TOKENS && groups.at(-1).length) { groups.push([]); size = base; }
    groups.at(-1).push(entry);
    size += t;
  }
  const t0 = Date.now();
  const replies = await Promise.all(groups.map((g) => {
    const qs = Object.fromEntries(g);
    let a;
    if (assets) {
      // only send the images this request's state/questions reference (unreferenced assets are a 400)
      const blob = JSON.stringify({ state, qs });
      a = Object.fromEntries(Object.entries(assets).filter(([k]) => blob.includes(k)));
    }
    return post(cfg, { model: cfg.model, state, questions: qs, ...(a && { assets: a }) }, opts);
  }));
  const answers = {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  let model = cfg.model;
  for (const r of replies) {
    Object.assign(answers, r?.answers || {});
    if (r?.model) model = r.model;
    for (const k of Object.keys(usage)) usage[k] += Number(r?.usage?.[k]) || 0;
  }
  return { answers, usage, model, requests: groups.length, latencyMs: Date.now() - t0, costDollars: usage.input_tokens * PRICE_PER_INPUT_TOKEN };
}

// Graded relevance of each passage to the query, 0..1. A 4-level score question gives a
// finer signal than yes/no: Jev returns a probability-weighted level we divide by 3.
export const RELEVANCE_LEVELS = [
  'Irrelevant: about something else.',
  'Related topic, but does not help answer the query.',
  'Partly answers the query or gives useful supporting facts.',
  'Directly and specifically answers the query.',
];

export async function scorePassages(query, passages, { cfg = jevConfig(), fetchImpl, maxWords = 180 } = {}) {
  if (!cfg) throw new Error('Jev not configured (TYPESAFE_API_KEY)');
  const questions = {};
  passages.forEach((p, i) => {
    questions[`p${i}`] = {
      type: 'score',
      instructions: {
        question: 'How well does `passage` answer the search query in `query`?',
        passage: { source: p.title ? words(p.title, 20) : undefined, section: p.heading ? words(p.heading, 14) : undefined, text: words(p.text, maxWords) },
      },
      criteria: RELEVANCE_LEVELS,
    };
  });
  const r = await askAll(cfg, { state: { query }, questions }, { fetchImpl });
  const scores = passages.map((_, i) => {
    const a = r.answers[`p${i}`];
    if (a && typeof a.score === 'number') return Math.max(0, Math.min(1, a.score / (RELEVANCE_LEVELS.length - 1)));
    if (a && typeof a.noul === 'number') return a.noul;
    return null;
  });
  return { scores, usage: r.usage, model: r.model, requests: r.requests, latencyMs: r.latencyMs, costDollars: r.costDollars };
}

// Photo matching: does each candidate image show the same item as the query photo?
// images: { query: {format, data_base64}, candidates: [{ id, format, data_base64 }] }.
// Returns probabilities keyed by candidate id.
export async function matchImages(images, { cfg = jevConfig(), fetchImpl, hint = '' } = {}) {
  if (!cfg) throw new Error('Jev not configured (TYPESAFE_API_KEY)');
  if (!cfg.images) throw new Error('Jev image input is off (set WEBCRAWL_JEV_IMAGES=on; experimental Danger Zone feature)');
  const tag = () => `img_${randomUUID().replace(/-/g, '')}`;
  const qTag = tag();
  const assets = { [qTag]: { type: 'image', format: images.query.format, data_base64: images.query.data_base64 } };
  const questions = {};
  const ids = {};
  images.candidates.forEach((c, i) => {
    const t = tag();
    assets[t] = { type: 'image', format: c.format, data_base64: c.data_base64 };
    ids[`c${i}`] = c.id;
    questions[`c${i}`] = {
      type: 'noul',
      instructions: {
        question: 'Does `candidate` show the same item as `photo` — the same product or model, not merely the same kind of thing?',
        candidate: t,
      },
    };
  });
  // Few images per request keeps every request well under the 32 MiB body limit.
  const out = {};
  let usage = { input_tokens: 0, output_tokens: 0 }, cost = 0, model = cfg.model;
  const keys = Object.keys(questions);
  for (let i = 0; i < keys.length; i += 6) {
    const slice = Object.fromEntries(keys.slice(i, i + 6).map((k) => [k, questions[k]]));
    const r = await askAll(cfg, { state: { photo: qTag, ...(hint && { what_the_user_is_looking_for: hint }) }, questions: slice, assets }, { fetchImpl, images: true });
    for (const [k, a] of Object.entries(r.answers)) if (typeof a?.noul === 'number') out[ids[k]] = a.noul;
    usage.input_tokens += r.usage.input_tokens; usage.output_tokens += r.usage.output_tokens; cost += r.costDollars; model = r.model;
  }
  return { probabilities: out, usage, costDollars: cost, model };
}

// Visual relevance: does a page screenshot show information that answers the query?
// Catches answers living in charts, tables-as-images, product photos and scans.
export async function scoreScreenshots(query, shots, { cfg = jevConfig(), fetchImpl } = {}) {
  if (!cfg) throw new Error('Jev not configured (TYPESAFE_API_KEY)');
  if (!cfg.images) throw new Error('Jev image input is off (set WEBCRAWL_JEV_IMAGES=on)');
  const assets = {}, questions = {};
  shots.forEach((s, i) => {
    const t = `img_${randomUUID().replace(/-/g, '')}`;
    assets[t] = { type: 'image', format: s.format, data_base64: s.data_base64 };
    questions[`s${i}`] = {
      type: 'score',
      instructions: { question: 'How well does the web page shown in `screenshot` answer the search query in `query`?', screenshot: t },
      criteria: RELEVANCE_LEVELS,
    };
  });
  const scores = new Array(shots.length).fill(null);
  let cost = 0;
  const keys = Object.keys(questions);
  for (let i = 0; i < keys.length; i += 4) {
    const slice = Object.fromEntries(keys.slice(i, i + 4).map((k) => [k, questions[k]]));
    const r = await askAll(cfg, { state: { query }, questions: slice, assets }, { fetchImpl, images: true });
    for (const [k, a] of Object.entries(r.answers)) if (typeof a?.score === 'number') scores[Number(k.slice(1))] = a.score / (RELEVANCE_LEVELS.length - 1);
    cost += r.costDollars;
  }
  return { scores, costDollars: cost };
}
