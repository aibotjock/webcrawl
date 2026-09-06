// Shared lazy chromium: render/screenshot with per-page hard timeout.
// Blocks fonts/media for speed; keeps css/images (layout fidelity).
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

let browser = null;
let idleTimer = null;

export async function closeBrowser() {
  clearTimeout(idleTimer);
  if (!browser) return;
  const b = browser;
  browser = null;
  await b.close().catch(() => {});
}

function bumpIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeBrowser(), 60_000);
  idleTimer.unref();
}

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
    });
    bumpIdle();
  }
  return browser;
}

// Run fn(page, response). Shared context per call; hard timeout per page.
export async function withPage(url, fn, { timeoutMs = config.timeoutMs, waitUntil = 'domcontentloaded', viewport = { width: 1280, height: 800 } } = {}) {
  const b = await getBrowser();
  const ctx = await b.newContext({
    viewport,
    userAgent: config.userAgent,
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  await ctx.route('**/*', (route) => {
    const t = route.request().resourceType();
    return t === 'font' || t === 'media' ? route.abort() : route.continue();
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeoutMs);
  try {
    const resp = await page.goto(url, { waitUntil, timeout: timeoutMs });
    return await fn(page, resp);
  } finally {
    await ctx.close().catch(() => {});
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
  if (waitFor) await page.waitForTimeout(Math.min(waitFor, 60_000));
}

export async function renderPage(url, { timeoutMs = config.timeoutMs, waitUntil, viewport, waitFor } = {}) {
  const t0 = Date.now();
  try {
    return await withPage(
      url,
      async (page, resp) => {
        await settle(page, waitFor, timeoutMs);
        return { status: resp?.status() ?? 200, html: await page.content(), finalUrl: page.url(), latencyMs: Date.now() - t0 };
      },
      { timeoutMs, waitUntil, viewport }
    );
  } catch (e) {
    return { status: 0, html: '', finalUrl: url, latencyMs: Date.now() - t0, error: String(e?.message || e) };
  }
}

export async function screenshotPage(url, { fullPage = false, viewport, timeoutMs = config.timeoutMs, waitFor } = {}) {
  const t0 = Date.now();
  try {
    return await withPage(
      url,
      async (page, resp) => {
        await settle(page, waitFor, timeoutMs);
        const buf = await page.screenshot({ fullPage, type: 'png' });
        const screenshotPath = join(tmpdir(), `webcrawl-shot-${randomUUID()}.png`);
        await writeFile(screenshotPath, buf);
        return {
          status: resp?.status() ?? 200,
          screenshot: `data:image/png;base64,${buf.toString('base64')}`,
          screenshotPath,
          finalUrl: page.url(),
          latencyMs: Date.now() - t0,
        };
      },
      // Firecrawl parity: screenshot default viewport 1920x1080 unless mobile.
      { timeoutMs, viewport: viewport || { width: 1920, height: 1080 } }
    );
  } catch (e) {
    return { status: 0, finalUrl: url, latencyMs: Date.now() - t0, error: String(e?.message || e) };
  }
}
