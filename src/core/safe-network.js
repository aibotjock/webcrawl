// All untrusted web traffic passes through this transport, including Chromium
// subresources. The checked DNS answer is the socket lookup answer: validating a
// hostname and then letting fetch/Chromium resolve it again is not sufficient.
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const v4Blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) v4Blocked.addSubnet(address, prefix, 'ipv4');
// Azure WireServer is a fabric/host service despite its public-shaped address.
// https://learn.microsoft.com/azure/virtual-network/what-is-ip-address-168-63-129-16
v4Blocked.addAddress('168.63.129.16', 'ipv4');
const v6Global = new BlockList();
v6Global.addSubnet('2000::', 3, 'ipv6');
const v6Blocked = new BlockList();
// Conservative exclusions: protocol assignments, docs and IPv4 transition
// ranges can otherwise tunnel to a private IPv4 address.
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  v6Blocked.addSubnet(address, prefix, 'ipv6');
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !v4Blocked.check(address, 'ipv4');
  if (family === 6) return v6Global.check(address, 'ipv6') && !v6Blocked.check(address, 'ipv6');
  return false;
}

export function parsePublicUrl(input) {
  if (typeof input !== 'string' || input.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(input)) throw new Error('Invalid web URL');
  let url;
  try { url = new URL(input); } catch { throw new Error('Invalid web URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || url.port && !['80', '443'].includes(url.port)) {
    throw new Error('Only public HTTP(S) URLs on standard ports are allowed');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (hostname.includes('%') || hostname === 'localhost' || /\.(?:localhost|local|internal|home|lan|test|invalid)$/.test(hostname) || !isIP(hostname) && !hostname.includes('.')) {
    throw new Error('Private or local destination is not allowed');
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error('Private or reserved destination is not allowed');
  url.hash = '';
  return url;
}

export async function resolvePublicUrl(input, { lookup = dnsLookup, timeoutMs = 5000 } = {}) {
  const url = parsePublicUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let timer;
  try {
    const answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs); }),
    ]);
    if (!Array.isArray(answers) || !answers.length || answers.length > 64 || answers.some(a => !isPublicAddress(a.address) || isIP(a.address) !== a.family)) {
      throw new Error('DNS returned a private, reserved or invalid destination');
    }
    return { url, address: answers[0].address, family: answers[0].family };
  } finally { clearTimeout(timer); }
}

const forbiddenRequestHeaders = new Set(['host', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'accept-encoding', 'content-length']);
const forbiddenResponseHeaders = new Set(['connection', 'transfer-encoding', 'content-encoding', 'content-length', 'keep-alive', 'proxy-authenticate', 'trailer', 'upgrade', 'set-cookie']);
export function cleanResponseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([key, value]) => value !== undefined && !forbiddenResponseHeaders.has(key.toLowerCase())).map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : String(value)]));
}

// Injection points are only for offline regression tests; request callers never
// supply resolver, agent, proxy or connection options.
export function createPublicRequester({ lookup = dnsLookup, requestImpl } = {}) {
  return async function publicRequest(input, options = {}) {
    const timeoutMs = Math.min(30000, Math.max(1, Number(options.timeoutMs) || 15000));
    const maxBytes = Math.min(5 * 1024 * 1024, Math.max(1, Number(options.maxBytes ?? options.maxBody) || 2 * 1024 * 1024));
    const maxRedirects = Math.min(5, Math.max(0, Number.isInteger(options.maxRedirects) ? options.maxRedirects : 5));
    const deadline = Date.now() + timeoutMs;
    let method = options.method || 'GET';
    if (!['GET', 'HEAD', 'POST'].includes(method)) throw new Error('Unsupported web request method');
    let body = options.body === undefined || options.body === null ? undefined : Buffer.from(options.body);
    if (body && body.length > 128 * 1024) throw new Error('Web request body too large');
    let headers = Object.fromEntries(Object.entries(options.headers || {}).filter(([key]) => !forbiddenRequestHeaders.has(key.toLowerCase())));
    headers['accept-encoding'] = 'identity';
    let current = String(input);
    for (let hop = 0; ; hop++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || options.signal?.aborted) throw new Error('Web request cancelled or timed out');
      const target = await resolvePublicUrl(current, { lookup, timeoutMs: Math.min(5000, remaining) });
      const response = await new Promise((resolve, reject) => {
        let settled = false;
        let req;
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          if (error) { req?.destroy(); reject(error); } else resolve(result);
        };
        const abort = () => finish(new Error('Web request cancelled'));
        const timer = setTimeout(() => finish(new Error('Web request timed out')), Math.max(1, deadline - Date.now()));
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) return abort();
        const request = requestImpl || (target.url.protocol === 'https:' ? https.request : http.request);
        try { req = request(target.url, {
          method, headers, agent: false, maxHeaderSize: 16384,
          // Keep hostname/SNI and certificate verification; only DNS is pinned.
          lookup: (_hostname, opts, callback) => {
            const answer = { address: target.address, family: target.family };
            callback(null, opts?.all ? [answer] : answer.address, answer.family);
          },
        }, res => {
          const status = res.statusCode || 0;
          const location = res.headers.location;
          if ([301, 302, 303, 307, 308].includes(status) && location) {
            res.destroy();
            return finish(null, { status, headers: res.headers, location, body: Buffer.alloc(0) });
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); return finish(new Error('Web response exceeds size limit')); }
          const encoding = String(res.headers['content-encoding'] || 'identity').toLowerCase();
          let stream = res;
          if (encoding === 'gzip') stream = res.pipe(createGunzip());
          else if (encoding === 'deflate') stream = res.pipe(createInflate());
          else if (encoding === 'br') stream = res.pipe(createBrotliDecompress());
          else if (encoding !== 'identity') { res.destroy(); return finish(new Error('Unsupported response encoding')); }
          let bytes = 0;
          let wireBytes = 0;
          const chunks = [];
          res.on('data', chunk => { wireBytes += chunk.length; if (wireBytes > maxBytes) { res.destroy(); stream.destroy(); finish(new Error('Web response exceeds wire size limit')); } });
          res.on('error', error => finish(error));
          res.on('aborted', () => finish(new Error('Web response ended prematurely')));
          stream.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > maxBytes) { stream.destroy(); res.destroy(); finish(new Error('Web response exceeds decoded size limit')); }
            else chunks.push(chunk);
          });
          stream.on('error', error => finish(error));
          stream.on('end', () => finish(null, { status, headers: cleanResponseHeaders(res.headers), body: Buffer.concat(chunks) }));
        });
        req.on('error', error => finish(error));
        req.on('upgrade', (_res, socket) => { socket.destroy(); finish(new Error('Protocol upgrade is not allowed')); });
        req.end(body);
        } catch (error) { finish(error); }
      });
      if (!response.location) return { ...response, url: target.url.href, ok: response.status >= 200 && response.status < 300 };
      if (options.redirect === 'error') throw new Error('Redirect is not allowed');
      const next = parsePublicUrl(new URL(response.location, target.url).href);
      if (target.url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS downgrade redirect is not allowed');
      if (options.followRedirects === false || options.redirect === 'manual') return { ...response, headers: { ...cleanResponseHeaders(response.headers), location: next.href }, url: target.url.href, ok: false };
      if (hop >= maxRedirects) throw new Error('Too many redirects');
      if (next.origin !== target.url.origin) headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !['authorization', 'cookie', 'x-api-key', 'origin', 'referer'].includes(key.toLowerCase())));
      if (response.status === 303 || [301, 302].includes(response.status) && method === 'POST') { method = 'GET'; body = undefined; }
      current = next.href;
    }
  };
}

export const publicRequest = createPublicRequester();

export async function safeFetch(input, options = {}) {
  const response = await publicRequest(String(input), {
    ...options,
    timeoutMs: options.timeoutMs ?? options.timeout,
    body: options.body instanceof URLSearchParams ? options.body.toString() : options.body,
    headers: options.headers instanceof Headers ? Object.fromEntries(options.headers) : options.headers,
  });
  return { ...response, headers: new Headers(response.headers),
    text: async () => response.body.toString('utf8'),
    json: async () => JSON.parse(response.body.toString('utf8')),
    arrayBuffer: async () => response.body.buffer.slice(response.body.byteOffset, response.body.byteOffset + response.body.byteLength),
  };
}

export function createDenyProxy() {
  const server = http.createServer((_req, res) => { res.writeHead(403, { Connection: 'close' }); res.end(); });
  server.on('connect', (_req, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 32;
  return server;
}
