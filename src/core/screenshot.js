// Screenshots are returned inline only. No temporary files survive a request,
// process exit or restart, so repeated captures cannot accumulate on disk.
export function screenshotResult(buffer, { status = 200, url, startedAt = Date.now() } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 5 * 1024 * 1024) throw new Error('Screenshot exceeds size limit');
  return {
    status,
    screenshot: `data:image/png;base64,${buffer.toString('base64')}`,
    finalUrl: url,
    latencyMs: Math.max(0, Date.now() - startedAt),
  };
}
