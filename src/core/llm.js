// Runtime-switchable LLM client for webcrawl (/extract + the WebUI model picker).
//
// One small client that powers BOTH:
//   - local models  — Ollama / LM Studio / llama.cpp (OpenAI-compatible, no API key needed)
//   - cloud models   — any OpenAI-compatible endpoint (OpenAI, Abacus gateway, etc.) with a Bearer key
//   - Anthropic Claude — the native /v1/messages API (x-api-key + anthropic-version headers)
//
// Anthropic's API is NOT OpenAI-compatible, so when the selected provider is
// "anthropic" we transparently translate requests/responses to and from the
// OpenAI chat shape. Callers (extract.js, the /v1/llm routes) use the same
// public interface regardless of provider.
//
// Settings are seeded from env once (see below) and can be changed at runtime via
// POST /v1/llm without restarting the server, so the WebUI can flip between a local
// box and a cloud provider live. The raw API key is never returned to clients.
//
// Env seeds (all optional):
//   WEBCRAWL_LLM_PROVIDER   provider id (see PRESETS). default 'lmstudio'
//   WEBCRAWL_LLM_BASE_URL   base URL (OpenAI-compatible /v1, or https://api.anthropic.com/v1 for Claude)
//   WEBCRAWL_LLM_MODEL      model id, e.g. gpt-4o-mini / llama3.1 / claude-3-5-sonnet-latest
//   WEBCRAWL_LLM_API_KEY    key for cloud providers (Bearer, or x-api-key for Anthropic; omit for local)
//   ANTHROPIC_API_KEY       fallback key used when provider=anthropic and WEBCRAWL_LLM_API_KEY is unset
//   WEBCRAWL_ANTHROPIC_VERSION  anthropic-version header (default 2023-06-01)

// Known providers. Order matters — the WebUI provider dropdown is built from this order, so the
// default (anthropic) is listed first. `model` is a suggested default the WebUI prefills when you
// pick the preset. `keyless: true` => local runtime that needs no auth header.
export const PRESETS = {
  anthropic: { label: 'Anthropic Claude (cloud)',  baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest', keyless: false, kind: 'cloud' },
  openai:    { label: 'OpenAI (cloud)',            baseUrl: 'https://api.openai.com/v1',    model: 'gpt-4o-mini',              keyless: false, kind: 'cloud' },
  cloud:     { label: 'Cloud (OpenAI-compatible)', baseUrl: '',                             model: '',                         keyless: false, kind: 'cloud' },
  lmstudio:  { label: 'LM Studio (local)',         baseUrl: 'http://127.0.0.1:1234/v1',     model: '',                         keyless: true,  kind: 'local' },
  ollama:    { label: 'Ollama (local)',            baseUrl: 'http://127.0.0.1:11434/v1',    model: 'llama3.1',                 keyless: true,  kind: 'local' },
  llamacpp:  { label: 'llama.cpp (local)',         baseUrl: 'http://127.0.0.1:8080/v1',     model: '',                         keyless: true,  kind: 'local' },
};

const ANTHROPIC_VERSION = process.env.WEBCRAWL_ANTHROPIC_VERSION || '2023-06-01';
const stripSlash = (u) => String(u || '').trim().replace(/\/+$/, '');

// Provider used out of the box when the environment sets nothing. Anthropic Claude is the
// shipped default; any deployment can still pin a different provider via the WEBCRAWL_LLM_* env
// vars (e.g. the live host keeps a working OpenAI-compatible gateway in its .env).
export const DEFAULT_PROVIDER = 'anthropic';

const defaultModelFor = (p) => (p === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'local-model');

// Seed runtime settings from env, with provider-aware defaults.
const SEED_PROVIDER = (process.env.WEBCRAWL_LLM_PROVIDER || DEFAULT_PROVIDER).trim();
const SEED_PRESET = PRESETS[SEED_PROVIDER];
// Anthropic accepts its key from either WEBCRAWL_LLM_API_KEY or the conventional ANTHROPIC_API_KEY.
const SEED_KEY = process.env.WEBCRAWL_LLM_API_KEY
  || (SEED_PROVIDER === 'anthropic' ? (process.env.ANTHROPIC_API_KEY || '') : '');

// Live, mutable runtime settings.
export const llm = {
  provider: SEED_PROVIDER,
  baseUrl: stripSlash(
    process.env.WEBCRAWL_LLM_BASE_URL || (SEED_PRESET && SEED_PRESET.baseUrl) || 'http://127.0.0.1:1234/v1',
  ),
  model: process.env.WEBCRAWL_LLM_MODEL || defaultModelFor(SEED_PROVIDER),
  apiKey: SEED_KEY,
};

// Human-readable warning when the current config can't actually reach a model, so the WebUI and
// logs can tell the user what to do. Empty string means the config looks usable. This is the
// graceful part of "Anthropic is the default": if no key is present, nothing crashes — extract
// degrades to its heuristic mode (see extract.js) and this note explains why.
export function llmNote() {
  const preset = PRESETS[llm.provider];
  if (llm.provider === 'anthropic' && !llm.apiKey) {
    return 'Anthropic Claude is the default provider but no API key is set. Add ANTHROPIC_API_KEY (or paste a key in the Model panel), or switch to another provider. Until then, extract falls back to heuristic mode.';
  }
  if (preset && !preset.keyless && !llm.apiKey) {
    return `${preset.label} needs an API key — add one in the Model panel or switch to a local provider. Extract uses heuristic mode until then.`;
  }
  return '';
}

const isAnthropic = () => llm.provider === 'anthropic';

// Anthropic endpoints live under /v1 — accept either https://api.anthropic.com or .../v1.
function anthropicBase() {
  const b = stripSlash(llm.baseUrl);
  return /\/v\d+$/.test(b) ? b : `${b}/v1`;
}

export function llmHeaders() {
  const h = { 'content-type': 'application/json' };
  if (isAnthropic()) {
    if (llm.apiKey) h['x-api-key'] = llm.apiKey;
    h['anthropic-version'] = ANTHROPIC_VERSION;
    return h;
  }
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
    note: llmNote(),
    presets: Object.fromEntries(
      Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label, baseUrl: v.baseUrl, model: v.model, keyless: v.keyless, kind: v.kind }]),
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

// URL of the endpoint's model-list route (same for OpenAI-compatible and Anthropic: GET /models).
const modelsUrl = () => (isAnthropic() ? `${anthropicBase()}/models` : `${llm.baseUrl}/models`);

// True if the configured endpoint answers GET /models. Used by /extract and /v1/test.
export async function llmReachable(timeoutMs = 2500) {
  try {
    const r = await fetch(modelsUrl(), { headers: llmHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

// List model ids the endpoint advertises (for the WebUI model dropdown).
// Both OpenAI-compatible and Anthropic return { data: [{ id, ... }] }.
export async function llmModels(timeoutMs = 5000) {
  const r = await fetch(modelsUrl(), { headers: llmHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`models http ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return (j.data || []).map((m) => m && m.id).filter(Boolean);
}

// Translate an OpenAI chat request into Anthropic /v1/messages, then translate the
// reply back into the OpenAI chat shape { choices: [{ message: { content } }] } so
// callers don't need to know which provider answered.
async function anthropicChat(body, timeoutMs) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  // Anthropic takes the system prompt as a top-level string, not a message role.
  const system = msgs.filter((m) => m && m.role === 'system').map((m) => m.content).filter(Boolean).join('\n\n').trim();
  const messages = msgs
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
  const payload = {
    model: body.model || llm.model,
    max_tokens: body.max_tokens || 4096,
    messages,
  };
  if (system) payload.system = system;
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;

  const res = await fetch(`${anthropicBase()}/messages`, {
    method: 'POST', headers: llmHeaders(), body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { status: res.status, j }; // surface the raw error to the caller
  const text = Array.isArray(j.content)
    ? j.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('')
    : '';
  return { status: res.status, j: { choices: [{ message: { role: 'assistant', content: text } }] } };
}

// One chat round-trip. Returns { status, j } in OpenAI chat shape — never throws on HTTP status.
export async function chatCompletion(body, timeoutMs = 180000) {
  if (isAnthropic()) return anthropicChat(body, timeoutMs);
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST', headers: llmHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, j: await res.json().catch(() => ({})) };
}
