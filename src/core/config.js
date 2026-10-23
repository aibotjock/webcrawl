// webcrawl config — env-read once, defaults tuned for a local box.
export const config = {
  port: Number(process.env.PORT || 8787),
  llmBaseUrl: process.env.WEBCRAWL_LLM_BASE_URL || 'http://127.0.0.1:1234/v1',
  llmModel: process.env.WEBCRAWL_LLM_MODEL || 'qwen3.8-whittle-moe-27b-a17.8b',
  concurrency: Math.min(4, Math.max(1, Math.trunc(Number(process.env.WEBCRAWL_CONCURRENCY) || 4))),
  timeoutMs: Math.min(30000, Math.max(1000, Number(process.env.WEBCRAWL_TIMEOUT_MS) || 15000)),
  userAgent:
    process.env.WEBCRAWL_UA ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};
