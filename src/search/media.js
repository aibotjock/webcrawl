// Page metadata (publish date, images) and image normalization for vision models.
import { normalizeUrl } from '../core/fetch.js';
import { config } from '../core/config.js';

const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i')) || [])[1];
const metaTags = (html) => html.match(/<meta\b[^>]*>/gi) || [];

// Best-effort publish date: meta tags, JSON-LD, then <time datetime>. ISO string or undefined.
export function publishedDateOf(html) {
  if (!html) return undefined;
  const keys = /^(article:published_time|og:published_time|datepublished|publish[-_]?date|pubdate|date|dc\.date|dc\.date\.issued|sailthru\.date|parsely-pub-date)$/i;
  for (const t of metaTags(html)) {
    const k = attr(t, 'property') || attr(t, 'name') || attr(t, 'itemprop');
    if (k && keys.test(k)) { const d = toIso(attr(t, 'content')); if (d) return d; }
  }
  const ld = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
  if (ld) { const d = toIso(ld[1]); if (d) return d; }
  const tm = html.match(/<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i);
  return tm ? toIso(tm[1]) : undefined;
}
function toIso(s) {
  if (!s) return undefined;
  const t = Date.parse(s);
  if (!Number.isFinite(t) || t < Date.parse('1995-01-01') || t > Date.now() + 2 * 864e5) return undefined;
  return new Date(t).toISOString();
}

// Images worth comparing against a query photo: og/twitter image, JSON-LD product
// images, then large-looking <img> tags. Skips logos, icons, sprites, tracking pixels.
export function pageImages(html, baseUrl, max = 4) {
  if (!html) return [];
  const out = [];
  const push = (u) => {
    const v = normalizeUrl(u, baseUrl);
    if (!v || /\.svg(\?|$)|logo|icon|sprite|favicon|pixel|spacer|badge|avatar|1x1/i.test(v) || out.includes(v)) return;
    out.push(v);
  };
  for (const t of metaTags(html)) {
    const k = attr(t, 'property') || attr(t, 'name');
    if (k && /^(og:image(:secure_url)?|twitter:image(:src)?)$/i.test(k)) push(attr(t, 'content'));
  }
  for (const m of html.matchAll(/"image"\s*:\s*(\[[^\]]*\]|"[^"]+")/gi)) {
    try { const v = JSON.parse(m[1]); for (const u of [].concat(v)) if (typeof u === 'string') push(u); } catch {}
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (out.length >= max) break;
    const tag = m[0];
    const w = Number(attr(tag, 'width')), h = Number(attr(tag, 'height'));
    if ((w && w < 200) || (h && h < 200)) continue;
    push(attr(tag, 'data-old-hires') || attr(tag, 'data-src') || attr(tag, 'src'));
  }
  return out.slice(0, max);
}

// Jev accepts PNG/JPEG, 280..1568 px per side, 78,400..2,458,624 total pixels, no
// auto-resize or EXIF rotation. This makes any input fit: rotate, resize, JPEG.
export const JEV_IMAGE = { minSide: 280, maxSide: 1568, minPixels: 78400, maxPixels: 2458624 };

export async function normalizeImage(buf, { maxSide = 1024 } = {}) {
  const sharp = (await import('sharp')).default;
  let img = sharp(buf, { failOn: 'none', animated: false }).rotate();
  const meta = await img.metadata();
  let w = meta.width, h = meta.height;
  if (!w || !h) throw new Error('unreadable image');
  if (meta.orientation >= 5) [w, h] = [h, w];
  const ratio = Math.max(w, h) / Math.min(w, h);
  if (ratio > JEV_IMAGE.maxSide / JEV_IMAGE.minSide) throw new Error(`image too elongated (${w}x${h})`);
  const side = Math.min(maxSide, JEV_IMAGE.maxSide);
  let scale = Math.min(1, side / Math.max(w, h));          // shrink big images
  if (Math.min(w, h) * scale < JEV_IMAGE.minSide) scale = JEV_IMAGE.minSide / Math.min(w, h); // grow tiny ones
  const W = Math.max(JEV_IMAGE.minSide, Math.round(w * scale)), H = Math.max(JEV_IMAGE.minSide, Math.round(h * scale));
  const out = await img.resize(W, H, { fit: 'fill' }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
  return { format: 'jpeg', data_base64: out.toString('base64'), width: W, height: H, bytes: out.length };
}

// Accepts a data: URI, bare base64, or an http(s) URL. Returns a Buffer.
export async function loadImage(src, { fetchImpl = globalThis.fetch, maxBytes = 12 * 1024 * 1024, timeoutMs = 12000 } = {}) {
  const s = String(src || '').trim();
  if (/^data:image\//i.test(s)) return Buffer.from(s.slice(s.indexOf(',') + 1), 'base64');
  if (/^https?:\/\//i.test(s)) {
    const res = await fetchImpl(s, { headers: { 'user-agent': config.userAgent, accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`image http ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new Error('image too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('image too large');
    return buf;
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 100) return Buffer.from(s.replace(/\s+/g, ''), 'base64');
  throw new Error('image must be a data: URI, base64 string, or http(s) URL');
}
