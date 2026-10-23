// Chromium may not create its own outbound connections. Every HTTP request
// (documents, redirects, frames, workers and subresources) is fulfilled using
// the same pinned public-only transport as static scraping. A denying proxy is
// an additional fail-closed boundary for traffic not intercepted by routing.
import { publicRequest } from './safe-network.js';

export async function installBrowserNetwork(context, { request = publicRequest, signal, timeoutMs = 15000, maxRequests = 150, maxTotalBytes = 12 * 1024 * 1024 } = {}) {
  let count = 0;
  let bytes = 0;
  let active = 0;
  let stopped = false;
  const controllers = new Set();
  const stop = () => { stopped = true; for (const c of controllers) c.abort(); };
  signal?.addEventListener('abort', stop, { once: true });
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', async route => {
    const incoming = route.request();
    if (stopped || signal?.aborted || ++count > maxRequests || active >= 12 || bytes >= maxTotalBytes || ['font', 'media'].includes(incoming.resourceType())) {
      await route.abort().catch(() => {});
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    active++;
    try {
      // Only headers relevant to an anonymous page fetch. Never forward any
      // operator, ambient machine, proxy or API credentials into visited pages.
      const raw = incoming.headers();
      const headers = Object.fromEntries(['accept', 'accept-language', 'content-type', 'user-agent', 'referer', 'origin'].filter(k => raw[k]).map(k => [k, raw[k]]));
      const response = await request(incoming.url(), {
        method: incoming.method(), headers, body: incoming.postDataBuffer(),
        timeoutMs, maxBytes: Math.min(2 * 1024 * 1024, maxTotalBytes - bytes),
        followRedirects: false, signal: controller.signal,
      });
      bytes += response.body.length;
      if (stopped || bytes > maxTotalBytes) throw new Error('Browser response budget exceeded');
      // Chromium creates a fresh intercepted request for a redirect. The next
      // destination is therefore independently validated and socket-pinned.
      await route.fulfill({ status: response.status, headers: response.headers, body: response.body });
    } catch { await route.abort().catch(() => {}); }
    finally { active--; controllers.delete(controller); }
  });
  return () => { stop(); signal?.removeEventListener('abort', stop); };
}
