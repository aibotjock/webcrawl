// Operator-configured, keyless local models are separate from untrusted web
// URLs. Local access is limited to literal loopback, never a DNS hostname, and
// redirects cannot move a local request onto another destination.
import { config } from './config.js';
import { safeFetch } from './safe-network.js';

export async function modelFetch(endpoint, { body, timeoutMs = 15000 } = {}) {
  if (!['/models', '/chat/completions'].includes(endpoint)) throw new Error('Unsupported model operation');
  const base = new URL(config.llmBaseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid configured model destination');
  const local = ['127.0.0.1', '[::1]'].includes(base.hostname);
  if (!local && base.protocol !== 'https:') throw new Error('Cloud model destination must use HTTPS');
  const url = `${base.href.replace(/\/$/, '')}${endpoint}`;
  const init = { method: body === undefined ? 'GET' : 'POST', body, headers: { 'content-type': 'application/json' }, timeoutMs, redirect: 'error', maxBody: 2 * 1024 * 1024 };
  if (!local) return safeFetch(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(30000, Math.max(1, Number(timeoutMs) || 15000)));
  try {
    if (body && Buffer.byteLength(body) > 128 * 1024) throw new Error('Model request is too large');
    const response = await fetch(url, { ...init, signal: controller.signal });
    const chunks = [];
    let bytes = 0;
    if (response.body) for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { controller.abort(); throw new Error('Model response is too large'); }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    return { ok: response.ok, status: response.status, text: async () => buffer.toString('utf8'), json: async () => JSON.parse(buffer.toString('utf8')) };
  } finally { clearTimeout(timer); }
}
