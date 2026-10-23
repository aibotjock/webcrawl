// Shared lazy chromium: render/screenshot with per-page hard timeout.
// Blocks fonts/media for speed; keeps css/images (layout fidelity).
import { chromium } from 'playwright';
import { config } from './config.js';
import { createDenyProxy, parsePublicUrl } from './safe-network.js';
import { installBrowserNetwork } from './browser-network.js';
import { screenshotResult } from './screenshot.js';

let browser = null;
let idleTimer = null;
let launching = null;
let denyProxy = null;
let activePages = 0;

export async function closeBrowser() {
  clearTimeout(idleTimer);
  if (!browser) return;
  const b = browser;
  browser = null;
  await b.close().catch(() => {});
  if (denyProxy) { denyProxy.closeAllConnections(); await new Promise(resolve => denyProxy.close(resolve)); denyProxy = null; }
}

function bumpIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeBrowser(), 60_000);
  idleTimer.unref();
}

async function getBrowser() {
  if (browser) return browser;
  if (!launching) launching = (async () => {
    denyProxy = createDenyProxy();
    await new Promise((resolve, reject) => { denyProxy.once('error', reject); denyProxy.listen(0, '127.0.0.1', resolve); });
    denyProxy.unref();
    try {
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        proxy: { server: `http://127.0.0.1:${denyProxy.address().port}`, bypass: '<-loopback>' },
        args: ['--proxy-bypass-list=<-loopback>', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-extensions', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      });
      bumpIdle();
      return browser;
    } catch (error) { denyProxy.close(); denyProxy = null; throw error; }
  })().finally(() => { launching = null; });
  return launching;
}

// Run fn(page, response). Shared context per call; hard timeout per page.
export async function withPage(url, fn, { timeoutMs = config.timeoutMs, waitUntil = 'domcontentloaded', viewport = { width: 1280, height: 800 }, signal } = {}) {
  parsePublicUrl(url);
  if (signal?.aborted) throw new Error('Browser request cancelled');
  if (activePages >= 3) throw new Error('Browser capacity reached');
  activePages++;
  timeoutMs = Math.min(30000, Math.max(1000, Number(timeoutMs) || config.timeoutMs));
  viewport = { width: Math.min(1920, Math.max(320, Number(viewport.width) || 1280)), height: Math.min(1080, Math.max(240, Number(viewport.height) || 800)) };
  let ctx;
  let releaseNetwork;
  let timer;
  const controller = new AbortController();
  const abort = () => { controller.abort(); ctx?.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
  const b = await getBrowser();
  ctx = await b.newContext({
    viewport,
    userAgent: config.userAgent,
    locale: 'en-US',
    timezoneId: 'UTC',
    serviceWorkers: 'block',
    acceptDownloads: false,
    permissions: [],
  });
  releaseNetwork = await installBrowserNetwork(ctx, { signal: controller.signal, timeoutMs });
  // Limit page-created popups as well as the explicit top-level tab.
  let pages = 0;
  ctx.on('page', p => { if (++pages > 1) p.close().catch(() => {}); });
  await ctx.addInitScript(() => {
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
      try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false }); } catch {}
    }
  });
  timer = setTimeout(() => { controller.abort(); ctx.close().catch(() => {}); }, timeoutMs);
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeoutMs);
    const resp = await page.goto(url, { waitUntil, timeout: timeoutMs });
    return await fn(page, resp);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    releaseNetwork?.();
    await ctx?.close().catch(() => {});
    activePages--;
    bumpIdle();
  }
}

async function settle(page, waitFor, timeoutMs) {
  await page.waitForLoadState('networkidle', { timeout: Math.min(3000, timeoutMs) }).catch(() => {});
  // DOM stabilization: XHR-rendered text can land right after networkidle —
  // poll until body text length is unchanged across two samples.
  const deadline = Date.now() + Math.min(4000, timeoutMs);
  let prev = -1;
  while (Date.now() < deadline) {
    const len = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0);
    if (len === prev && len > 0) break;
    prev = len;
    await page.waitForTimeout(250);
  }
  if (waitFor) await page.waitForTimeout(Math.min(Math.max(0, Number(waitFor) || 0), 3000));
}

export async function renderPage(url, { timeoutMs = config.timeoutMs, waitUntil, viewport, waitFor, signal } = {}) {
  const t0 = Date.now();
  try {
    return await withPage(
      url,
      async (page, resp) => {
        await settle(page, waitFor, timeoutMs);
        const html = await page.content();
        if (Buffer.byteLength(html) > 5 * 1024 * 1024) throw new Error('Rendered page exceeds size limit');
        return { status: resp?.status() ?? 200, html, finalUrl: page.url(), latencyMs: Date.now() - t0 };
      },
      { timeoutMs, waitUntil, viewport, signal }
    );
  } catch (e) {
    return { status: 0, html: '', finalUrl: url, latencyMs: Date.now() - t0, error: String(e?.message || e) };
  }
}

export async function screenshotPage(url, { fullPage = false, viewport, timeoutMs = config.timeoutMs, waitFor, signal } = {}) {
  const t0 = Date.now();
  try {
    return await withPage(
      url,
      async (page, resp) => {
        await settle(page, waitFor, timeoutMs);
        // Fixed viewport avoids attacker-controlled document dimensions causing
        // an unbounded full-page image allocation.
        const buf = await page.screenshot({ fullPage: false, type: 'png' });
        return screenshotResult(buf, { status: resp?.status() ?? 200, url: page.url(), startedAt: t0 });
      },
      // Firecrawl parity: screenshot default viewport 1920x1080 unless mobile.
      { timeoutMs, viewport: viewport || { width: 1920, height: 1080 }, signal }
    );
  } catch (e) {
    return { status: 0, finalUrl: url, latencyMs: Date.now() - t0, error: String(e?.message || e) };
  }
}
