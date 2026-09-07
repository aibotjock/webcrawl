// Runtime-switchable LLM client for webcrawl (/extract + the WebUI model picker).
//
// One small OpenAI-compatible client that powers BOTH:
//   - local models  — Ollama / LM Studio / llama.cpp (no API key needed)
//   - cloud models   — any OpenAI-compatible endpoint (OpenAI, Abacus gateway, etc.) with a Bearer key
//
// Settings are seeded from env once (see below) and can be changed at runtime via
// POST /v1/llm without restarting the server, so the WebUI can flip between a local
// box and a cloud provider live. The raw API key is never returned to clients.
//
// Env seeds (all optional):
//   WEBCRAWL_LLM_PROVIDER   provider id (see PRESETS). default 'lmstudio'
//   WEBCRAWL_LLM_BASE_URL   OpenAI-compatible base URL, e.g. https://api.openai.com/v1
//   WEBCRAWL_LLM_MODEL      model id, e.g. gpt-4o-mini / llama3.1 / local-model
//   WEBCRAWL_LLM_API_KEY    Bearer token for cloud providers (omit for local)

// Known providers. `keyless: true` => local runtime that needs no auth header.
export const PRESETS = {
  lmstudio: { label: 'LM Studio (local)',         baseUrl: 'http://127.0.0.1:1234/v1',  keyless: true,  kind: 'local' },
  ollama:   { label: 'Ollama (local)',            baseUrl: 'http://127.0.0.1:11434/v1', keyless: true,  kind: 'local' },
  llamacpp: { label: 'llama.cpp (local)',         baseUrl: 'http://127.0.0.1:8080/v1',  keyless: true,  kind: 'local' },
  openai:   { label: 'OpenAI (cloud)',            baseUrl: 'https://api.openai.com/v1', keyless: false, kind: 'cloud' },
  cloud:    { label: 'Cloud (OpenAI-compatible)', baseUrl: '',                          keyless: false, kind: 'cloud' },
};

const stripSlash = (u) => String(u || '').trim().replace(/\/+$/, '');

// Live, mutable runtime settings.
export const llm = {
  provider: process.env.WEBCRAWL_LLM_PROVIDER || 'lmstudio',
  baseUrl: stripSlash(process.env.WEBCRAWL_LLM_BASE_URL || 'http://127.0.0.1:1234/v1'),
  model: process.env.WEBCRAWL_LLM_MODEL || 'local-model',
  apiKey: process.env.WEBCRAWL_LLM_API_KEY || '',
};

export function llmHeaders() {
  const h = { 'content-type': 'application/json' };
  if (llm.apiKey) h.authorization = `Bearer ${llm.apiKey}`;
  return h;
}

// Safe snapshot for clients — reports whether a key is set, never the key itself.
export function llmPublic() {
  return {
    provider: llm.provider,
    baseUrl: llm.baseUrl,
    model: llm.model,
    hasKey: !!llm.apiKey,
    presets: Object.fromEntries(
      Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label, baseUrl: v.baseUrl, keyless: v.keyless, kind: v.kind }]),
    ),
  };
}

// Apply a partial update from POST /v1/llm. Returns the public snapshot. Throws on bad input.
export function setLlm(patch = {}) {
  if (patch == null || typeof patch !== 'object') throw new Error('body must be a JSON object');
  if (typeof patch.provider === 'string' && patch.provider.trim()) llm.provider = patch.provider.trim().slice(0, 40);
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
    const u = stripSlash(patch.baseUrl);
    if (!/^https?:\/\//i.test(u)) throw new Error('baseUrl must be an http(s) URL');
    llm.baseUrl = u;
  }
  if (typeof patch.model === 'string' && patch.model.trim()) llm.model = patch.model.trim().slice(0, 200);
  if (typeof patch.apiKey === 'string') llm.apiKey = patch.apiKey.trim(); // '' clears the key (back to keyless/local)
  return llmPublic();
}

// True if the configured endpoint answers GET /models. Used by /extract and /v1/test.
export async function llmReachable(timeoutMs = 2500) {
  try {
    const r = await fetch(`${llm.baseUrl}/models`, { headers: llmHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

// List model ids the endpoint advertises (for the WebUI model dropdown).
export async function llmModels(timeoutMs = 5000) {
  const r = await fetch(`${llm.baseUrl}/models`, { headers: llmHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`models http ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return (j.data || []).map((m) => m && m.id).filter(Boolean);
}

// One chat/completions round-trip. Returns { status, j } — never throws on HTTP status.
export async function chatCompletion(body, timeoutMs = 180000) {
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST', headers: llmHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, j: await res.json().catch(() => ({})) };
}
