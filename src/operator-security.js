import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const COOKIE = 'wc_operator';
const SESSION_MS = 60 * 60 * 1000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const digest = value => createHash('sha256').update(String(value)).digest();
const equal = (a, b) => timingSafeEqual(digest(a), digest(b));
const error = (res, status, message) => res.status(status).json({ success: false, error: message });

export function operatorConfig(env = process.env) {
  const host = env.WEBCRAWL_HOST || '127.0.0.1';
  if (host !== 'localhost' && !isIP(host)) throw new Error('WEBCRAWL_HOST must be an IP address or localhost');
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const token = env.WEBCRAWL_OPERATOR_TOKEN || '';
  if (token.length < 32 || token.length > 256 || /[\s\x00-\x1f\x7f]/.test(token)) {
    throw new Error('Set WEBCRAWL_OPERATOR_TOKEN to a random secret of 32 to 256 characters');
  }
  let origin;
  if (env.WEBCRAWL_PUBLIC_ORIGIN) {
    const u = new URL(env.WEBCRAWL_PUBLIC_ORIGIN);
    if (u.origin !== env.WEBCRAWL_PUBLIC_ORIGIN || u.username || u.password || !['http:', 'https:'].includes(u.protocol)) throw new Error('WEBCRAWL_PUBLIC_ORIGIN must be an exact HTTP(S) origin');
    if (u.protocol !== 'https:' && !LOOPBACK.has(u.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Remote WEBCRAWL_PUBLIC_ORIGIN must use HTTPS');
    origin = u.origin;
  } else {
    if (!LOOPBACK.has(host)) throw new Error('Non-loopback HTTP binding requires WEBCRAWL_PUBLIC_ORIGIN with HTTPS');
    origin = `http://${host === '::1' ? '[::1]' : host}:${port}`;
  }
  const hosts = new Set([new URL(origin).host]);
  if (LOOPBACK.has(host)) for (const h of ['127.0.0.1', 'localhost', '[::1]']) hosts.add(`${h}:${port}`);
  return { host, port, token, origin, hosts, secureCookie: origin.startsWith('https:') };
}

/** All HTTP operator capabilities share one authenticated workspace. No proxy headers grant access. */
export function createOperatorSecurity(settings, { now = Date.now } = {}) {
  const sessions = new Map();
  const buckets = new Map();
  let active = 0;
  function take(id, max, duration) {
    const t = now();
    let bucket = buckets.get(id);
    if (!bucket || bucket.until <= t) { bucket = { n: 0, until: t + duration }; buckets.set(id, bucket); }
    bucket.n++;
    // Bound memory even when clients arrive from many distinct transport addresses.
    if (buckets.size > 1024) for (const [key, value] of buckets) { if (value.until <= t || buckets.size > 1024) buckets.delete(key); }
    return bucket.n <= max;
  }
  function authenticated(req) {
    const authorization = String(req.headers.authorization || '');
    if (authorization) return authorization.startsWith('Bearer ') && equal(authorization.slice(7), settings.token);
    const cookies = String(req.headers.cookie || '').split(';').map(x => x.trim());
    const cookie = cookies.find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!cookie) return false;
    const key = digest(cookie).toString('hex');
    const until = sessions.get(key);
    if (!until || until <= now()) { sessions.delete(key); return false; }
    return true;
  }
  const cookie = (value, seconds) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${settings.secureCookie ? '; Secure' : ''}`;
  function middleware(req, res, next) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    if (!settings.hosts.has(String(req.headers.host || '').toLowerCase())) return error(res, 403, 'Unrecognized host');
    const origin = req.headers.origin;
    if (origin && origin !== settings.origin && !(`http://${req.headers.host}` === origin && LOOPBACK.has(settings.host))) return error(res, 403, 'Forbidden origin');
    if (req.headers['sec-fetch-site'] === 'cross-site') return error(res, 403, 'Forbidden origin');
    if (!/^\/v1(?:\/|$)/i.test(req.path)) return next();
    res.set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return error(res, 403, 'Cross-origin API access is disabled');
    if (!['GET', 'HEAD'].includes(req.method) && (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0' || req.headers['transfer-encoding']) && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return error(res, 415, 'JSON required');
    if (req.path === '/v1/login' && req.method === 'POST') {
      if (!take('login:global', 30, 300000) || !take(`login:${req.socket.remoteAddress}`, 10, 300000)) return error(res, 429, 'Too many sign-in attempts');
      return next();
    }
    if (!authenticated(req)) return error(res, 401, 'Operator sign-in required');
    if (!take('operator:requests', 240, 60000)) return error(res, 429, 'Request limit reached');
    if (active >= 8) return error(res, 429, 'The workspace is busy');
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    res.once('finish', release); res.once('close', release);
    next();
  }
  function login(req, res) {
    const token = req.body?.token;
    if (typeof token !== 'string' || token.length > 256 || !equal(token, settings.token)) return error(res, 401, 'Invalid operator token');
    for (const [key, until] of sessions) if (until <= now()) sessions.delete(key);
    if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
    const raw = randomBytes(32).toString('base64url');
    sessions.set(digest(raw).toString('hex'), now() + SESSION_MS);
    res.set('Set-Cookie', cookie(raw, SESSION_MS / 1000));
    return res.json({ success: true });
  }
  function logout(req, res) {
    const raw = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (raw) sessions.delete(digest(raw).toString('hex'));
    res.set('Set-Cookie', cookie('', 0));
    return res.json({ success: true });
  }
  return { middleware, login, logout, authenticated };
}
