// webcrawl config — env-read once, defaults tuned for a local box.
// LLM settings (local or cloud, runtime-switchable) now live in ./llm.js.
export const config = {
  port: Number(process.env.PORT || 8787),
  concurrency: Number(process.env.WEBCRAWL_CONCURRENCY || 8),
  timeoutMs: Number(process.env.WEBCRAWL_TIMEOUT_MS || 30000),
  userAgent:
    process.env.WEBCRAWL_UA ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};
