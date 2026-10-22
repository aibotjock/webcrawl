import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalizeImage, publishedDateOf, pageImages, loadImage, JEV_IMAGE } from '../../src/search/media.js';

const png = (w, h, color = '#c33') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();

test('normalizeImage fits Jev limits: shrinks big, grows tiny, outputs JPEG', async () => {
  for (const [w, h] of [[4000, 3000], [100, 80], [300, 1200]]) {
    const r = await normalizeImage(await png(w, h));
    assert.equal(r.format, 'jpeg');
    assert.ok(Math.min(r.width, r.height) >= JEV_IMAGE.minSide, `${w}x${h} -> ${r.width}x${r.height}`);
    assert.ok(Math.max(r.width, r.height) <= JEV_IMAGE.maxSide);
    assert.ok(r.width * r.height >= JEV_IMAGE.minPixels && r.width * r.height <= JEV_IMAGE.maxPixels);
    const meta = await sharp(Buffer.from(r.data_base64, 'base64')).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, r.width);
  }
});

test('normalizeImage rejects images too elongated to fit', async () => {
  await assert.rejects(normalizeImage(await png(3000, 100)), /elongated/);
});

test('loadImage accepts data URIs and bare base64', async () => {
  const b = await png(10, 10);
  assert.ok((await loadImage(`data:image/png;base64,${b.toString('base64')}`)).equals(b));
  const big = await png(300, 300);
  assert.ok((await loadImage(big.toString('base64'))).equals(big));
  await assert.rejects(loadImage('not an image'), /data: URI/);
});

test('publishedDateOf reads meta, JSON-LD and <time>', () => {
  assert.equal(publishedDateOf('<meta property="article:published_time" content="2026-02-03T10:00:00Z">'), '2026-02-03T10:00:00.000Z');
  assert.equal(publishedDateOf('<script type="application/ld+json">{"datePublished":"2025-07-01"}</script>'), '2025-07-01T00:00:00.000Z');
  assert.equal(publishedDateOf('<time datetime="2024-12-25">Xmas</time>'), '2024-12-25T00:00:00.000Z');
  assert.equal(publishedDateOf('<meta name="date" content="not a date">'), undefined);
  assert.equal(publishedDateOf('<meta name="date" content="2999-01-01">'), undefined, 'future dates ignored');
});

test('pageImages prefers og:image and skips logos and small icons', () => {
  const html = `<meta property="og:image" content="/main.jpg"><img src="/logo.png"><img src="/thumb.jpg" width="50"><img src="/big.jpg" width="800">
  <script type="application/ld+json">{"@type":"Product","image":["https://cdn.x/p1.jpg"]}</script>`;
  assert.deepEqual(pageImages(html, 'https://shop.x/item'), ['https://shop.x/main.jpg', 'https://cdn.x/p1.jpg', 'https://shop.x/big.jpg']);
});
