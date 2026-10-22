// Passage ranking without any model: chunking, BM25, plus optional embeddings from
// any OpenAI-compatible /embeddings endpoint (LM Studio, Ollama, vLLM, OpenAI...).
const env = (k) => String(process.env[k] || '').trim();

const STOP = new Set('a an and are as at be by for from has have how i in is it its of on or that the this to was what when where which who why will with you your do does can'.split(' '));
export const tokens = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .split(/[^a-z0-9]+/).filter((t) => t && t.length > 1 && !STOP.has(t));

// Splits markdown into ~maxWords passages along headings and paragraphs, keeping the
// nearest heading so a passage still makes sense on its own.
export function chunkMarkdown(md, { maxWords = 160, minWords = 25 } = {}) {
  const out = [];
  let heading = '', buf = [];
  const words = () => buf.join(' ').split(/\s+/).filter(Boolean).length;
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text && text.split(/\s+/).length >= Math.min(minWords, 8)) out.push({ heading, text });
    buf = [];
  };
  const clean = String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')          // links -> text
    .replace(/```[\s\S]*?```/g, (m) => m.slice(0, 1200)); // keep code but bounded
  for (const block of clean.split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    const h = b.match(/^#{1,6}\s+(.+)$/m);
    if (h && b.split('\n').length === 1) { flush(); heading = h[1].trim(); continue; }
    const n = b.split(/\s+/).length;
    if (n > maxWords) {
      flush();
      const sentences = b.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        buf.push(s);
        if (words() >= maxWords) flush();
      }
      flush();
      continue;
    }
    if (words() + n > maxWords) flush();
    buf.push(b);
  }
  flush();
  // merge tiny trailing passages into their neighbor
  return out.filter((p, i) => p.text.split(/\s+/).length >= minWords || i === 0 || out.length < 3);
}

// Okapi BM25 over a list of texts. Returns raw scores aligned with docs.
export function bm25(query, docs, { k1 = 1.2, b = 0.75 } = {}) {
  const q = [...new Set(tokens(query))];
  const toks = docs.map(tokens);
  const N = docs.length || 1;
  const avg = toks.reduce((s, t) => s + t.length, 0) / N || 1;
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
  return toks.map((t) => {
    const tf = new Map();
    for (const w of t) tf.set(w, (tf.get(w) || 0) + 1);
    let s = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg));
    }
    return s;
  });
}

// Scales scores into 0..1 (max-normalized; all-zero stays zero).
export const normalize = (xs) => { const m = Math.max(0, ...xs); return xs.map((x) => (m > 0 ? Math.max(0, x) / m : 0)); };

export const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

export function embedConfig() {
  const baseUrl = env('WEBCRAWL_EMBED_BASE_URL');
  return baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, ''), model: env('WEBCRAWL_EMBED_MODEL') || 'text-embedding-3-small', apiKey: env('WEBCRAWL_EMBED_API_KEY') } : null;
}

// Embeds texts in batches. Returns null when embeddings aren't configured or fail,
// so callers fall back to BM25 instead of erroring.
export async function embed(texts, { cfg = embedConfig(), fetchImpl = globalThis.fetch, batch = 64 } = {}) {
  if (!cfg || !texts.length) return null;
  const out = [];
  try {
    for (let i = 0; i < texts.length; i += batch) {
      const res = await fetchImpl(`${cfg.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey && { authorization: `Bearer ${cfg.apiKey}` }) },
        body: JSON.stringify({ model: cfg.model, input: texts.slice(i, i + batch).map((t) => t.slice(0, 8000)) }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const j = await res.json();
      const rows = (j.data || []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
      if (rows.length !== Math.min(batch, texts.length - i)) return null;
      out.push(...rows);
    }
    return out;
  } catch { return null; }
}

// Model-free relevance for passages: BM25, blended with embedding similarity when
// an embedding endpoint is configured. Returns 0..1 scores aligned with passages.
export async function lexicalSemanticScores(query, texts, { fetchImpl, cfg } = {}) {
  const lex = normalize(bm25(query, texts));
  const vecs = await embed([query, ...texts], { fetchImpl, cfg });
  if (!vecs) return { scores: lex, method: 'bm25' };
  const [qv, ...pv] = vecs;
  // cosine of typical embedding models sits in ~0.1..0.9; stretch it to 0..1
  const sem = pv.map((v) => Math.max(0, Math.min(1, (cosine(qv, v) - 0.15) / 0.65)));
  return { scores: sem.map((s, i) => 0.7 * s + 0.3 * lex[i]), method: 'bm25+embeddings' };
}

// Picks the best few sentences of a passage as a highlight.
export function bestSentences(query, text, n = 3) {
  const sents = String(text).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).filter((s) => s.length > 20);
  if (sents.length <= n) return sents.join(' ') || String(text).slice(0, 500);
  const sc = bm25(query, sents);
  const keep = sc.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, n).map(([, i]) => i).sort((a, b) => a - b);
  return keep.map((i) => sents[i]).join(' ');
}
