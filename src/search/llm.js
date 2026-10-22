// One chat interface over any LLM, cloud or local. Used only by the deep level,
// answers, summaries and the no-Jev photo fallback; every other level is model-free.
//
// WEBCRAWL_LLM_PROVIDER = openai (default: any OpenAI-compatible server — LM Studio,
//   Ollama, vLLM, llama.cpp, OpenAI, OpenRouter, Groq, Together, DeepSeek, xAI...)
//   | anthropic | gemini
// WEBCRAWL_LLM_BASE_URL, WEBCRAWL_LLM_MODEL, WEBCRAWL_LLM_API_KEY
import { config } from '../core/config.js';

const env = (k) => String(process.env[k] || '').trim();

export function llmConfig() {
  const provider = (env('WEBCRAWL_LLM_PROVIDER') || 'openai').toLowerCase();
  const apiKey = env('WEBCRAWL_LLM_API_KEY');
  const defaults = {
    openai: { baseUrl: config.llmBaseUrl, model: config.llmModel },
    anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: '' }, // set WEBCRAWL_LLM_MODEL
  }[provider];
  if (!defaults) return null;
  if (provider !== 'openai' && !apiKey) return null;
  if (!env('WEBCRAWL_LLM_MODEL') && !defaults.model) return null;
  return {
    provider,
    apiKey,
    baseUrl: (env('WEBCRAWL_LLM_BASE_URL') && provider !== 'openai' ? env('WEBCRAWL_LLM_BASE_URL') : defaults.baseUrl).replace(/\/+$/, ''),
    model: env('WEBCRAWL_LLM_MODEL') || defaults.model,
    timeoutMs: Number(env('WEBCRAWL_LLM_TIMEOUT_MS')) || 120000,
  };
}

// content: string, or an array of { type:'text', text } | { type:'image', format, data_base64 }
const parts = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);

function openaiBody(cfg, { system, messages, json, maxTokens }) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const m of messages) {
    const ps = parts(m.content);
    msgs.push({
      role: m.role,
      content: ps.every((p) => p.type === 'text') ? ps.map((p) => p.text).join('\n')
        : ps.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:image/${p.format};base64,${p.data_base64}` } })),
    });
  }
  return { model: cfg.model, temperature: 0, max_tokens: maxTokens, messages: msgs, ...(json && { response_format: { type: 'json_object' } }) };
}

async function call(cfg, req, fetchImpl) {
  const signal = AbortSignal.timeout(cfg.timeoutMs);
  if (cfg.provider === 'anthropic') {
    const body = {
      model: cfg.model, max_tokens: req.maxTokens, ...(req.system && { system: req.system }),
      messages: req.messages.map((m) => ({ role: m.role, content: parts(m.content).map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: `image/${p.format}`, data: p.data_base64 } })) })),
    };
    const res = await fetchImpl(`${cfg.baseUrl}/v1/messages`, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`anthropic http ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  if (cfg.provider === 'gemini') {
    const body = {
      ...(req.system && { systemInstruction: { parts: [{ text: req.system }] } }),
      contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: parts(m.content).map((p) => (p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: `image/${p.format}`, data: p.data_base64 } })) })),
      generationConfig: { temperature: 0, maxOutputTokens: req.maxTokens, ...(req.json && { responseMimeType: 'application/json' }) },
    };
    const res = await fetchImpl(`${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:generateContent`, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`gemini http ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }
  let body = openaiBody(cfg, req);
  const headers = { 'content-type': 'application/json', ...(cfg.apiKey && { authorization: `Bearer ${cfg.apiKey}` }) };
  let res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, { method: 'POST', signal, headers, body: JSON.stringify(body) });
  let j = await res.json().catch(() => ({}));
  if (res.status === 400 && body.response_format) { // some local servers reject response_format
    delete body.response_format;
    res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, { method: 'POST', signal, headers, body: JSON.stringify(body) });
    j = await res.json().catch(() => ({}));
  }
  if (!res.ok) throw new Error(`llm http ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.choices?.[0]?.message?.content || '';
}

export function parseJson(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  for (const [a, b] of [['{', '}'], ['[', ']']]) {
    const s = t.indexOf(a), e = t.lastIndexOf(b);
    if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  }
  return undefined;
}

export async function chat(req, { cfg = llmConfig(), fetchImpl = globalThis.fetch } = {}) {
  if (!cfg) throw new Error('no LLM configured (WEBCRAWL_LLM_PROVIDER / WEBCRAWL_LLM_API_KEY)');
  const text = await call(cfg, { maxTokens: 1500, ...req }, fetchImpl);
  return req.json ? parseJson(text) : text;
}

// Breaks a question into focused web queries for the deep level.
export async function expandQuery(query, { n = 4, ...opts } = {}) {
  const j = await chat({
    system: 'You plan web searches. Reply with JSON only: {"queries": ["..."]}.',
    messages: [{ role: 'user', content: `Write ${n} short, distinct web search queries (3-10 words each) that together cover what is needed to answer this thoroughly. Vary wording and angle; include one for the most specific fact asked.\n\nQuestion: ${query}` }],
    json: true, maxTokens: 400,
  }, opts);
  const qs = Array.isArray(j?.queries) ? j.queries : Array.isArray(j) ? j : [];
  return qs.map((q) => String(q).trim()).filter(Boolean).slice(0, n);
}

// Cited answer from ranked evidence. Sources are numbered [1]..[n] in `evidence` order.
export async function answerFrom(query, evidence, { schema, ...opts } = {}) {
  const ctx = evidence.map((e, i) => `[${i + 1}] ${e.title || e.url}\n${e.url}${e.publishedDate ? `\nPublished: ${e.publishedDate.slice(0, 10)}` : ''}\n${e.text}`).join('\n\n');
  if (schema) {
    const j = await chat({
      system: 'Fill the JSON schema using ONLY the numbered sources. Reply with JSON only: {"output": <value matching the schema>, "grounding": [{"field": "json.path", "sources": [n], "confidence": "high|medium|low"}]}. Use null where the sources are silent.',
      messages: [{ role: 'user', content: `Schema:\n${JSON.stringify(schema)}\n\nQuestion: ${query}\n\nSources:\n${ctx}` }],
      json: true, maxTokens: 2500,
    }, opts);
    return { output: j?.output ?? null, grounding: j?.grounding || [] };
  }
  const text = await chat({
    system: 'Answer using ONLY the numbered sources. Cite every claim inline like [2]. If the sources do not answer the question, say so plainly. Be concise.',
    messages: [{ role: 'user', content: `Question: ${query}\n\nSources:\n${ctx}` }],
    maxTokens: 1200,
  }, opts);
  return { answer: String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() };
}

// Photo-match fallback when Jev isn't available: asks a vision-capable LLM.
export async function judgeSameItem(photo, candidate, hint, opts = {}) {
  const j = await chat({
    system: 'You compare product photos. Reply with JSON only: {"same": true|false, "confidence": 0..1}.',
    messages: [{ role: 'user', content: [
      { type: 'text', text: `Do these two images show the same item (same product or model, not merely the same kind of thing)?${hint ? ` The user is looking for: ${hint}` : ''} First image is the user's photo.` },
      { type: 'image', ...photo }, { type: 'image', ...candidate },
    ] }],
    json: true, maxTokens: 100,
  }, opts);
  if (typeof j?.same !== 'boolean') return null;
  const c = Math.max(0, Math.min(1, Number(j.confidence) || 0.5));
  return j.same ? 0.5 + c / 2 : 0.5 - c / 2;
}
