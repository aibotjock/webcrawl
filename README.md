# webcrawl

Free, self-hosted Firecrawl alternative. One binary-ish Node process gives you:

- **scrape** — URL to clean Markdown / HTML / links / screenshot (headless chromium for JS pages)
- **crawl** — recursive same-origin site walk
- **map** — every URL on a domain, fast, no sitemap required
- **search** — keyless live web search
- **extract** — unstructured page to strict typed JSON from a schema (local LLM, no CSS selectors)
- **HTTP API** (Firecrawl-parity routes) + **MCP server** (Claude Code, LM Studio, Hermes) + **WebUI**

```bash
npm ci --ignore-scripts
npx --no-install playwright install chromium
# Set WEBCRAWL_OPERATOR_TOKEN to your own random secret (32–256 characters).
npm start          # authenticated HTTP API + WebUI on 127.0.0.1:8787
npm run mcp        # stdio MCP server
```

The HTTP server requires `WEBCRAWL_OPERATOR_TOKEN`, including on localhost. The
WebUI asks for this token and exchanges it for an expiring HttpOnly,
SameSite=Strict cookie; the token is not saved in browser storage. API clients
send `Authorization: Bearer <operator token>`. Keep this operator credential
separate from provider API credentials. This is one trusted-operator workspace,
not a multi-tenant service.

`WEBCRAWL_HOST` defaults to `127.0.0.1`. For an intentional remote deployment,
set the bind address and `WEBCRAWL_PUBLIC_ORIGIN` to the exact HTTPS origin served
by a TLS reverse proxy. Host and browser Origin checks use this configured
origin; forwarding headers do not authenticate requests. Cross-origin API access
is disabled. Do not publish a development listener or bypass these controls.

Scrape, crawl, map, search, redirects and browser subresources can reach public
HTTP(S) addresses on ports 80/443 only. Private, loopback, link-local, reserved,
mixed public/private DNS answers and IPv4 transition ranges are rejected. The
HTTP connection uses the validated DNS address, preventing a second lookup from
rebinding a public name to an internal address. Chromium fulfills intercepted
requests through this same transport; an always-denying proxy blocks traffic
outside the broker. Service workers, WebSockets, downloads and direct WebRTC
network access are disabled. Chromium's sandbox is required: run as a non-root
user on a host supporting it; browser operations fail if sandboxing is
unavailable. Static scraping continues without a browser.

Bounds include 128 KiB API bodies, 8 active HTTP requests, 2 background crawls,
32 retained crawl jobs, 100 attempted pages per crawl, 4 crawl workers, a 120 s
crawl deadline, 30 s per web request and 2 MiB ordinary web response bodies.
Decoded compressed responses are bounded too. Browser operations allow up to
150 requests, a bounded response budget and 3 concurrent pages. Screenshots use
a bounded viewport even when `fullPage` is requested, and return inline PNG data
without writing temporary screenshot files. These limits deliberately
trade some large or unusual-site compatibility for predictable resource use.

The optional model endpoint is operator configuration, never a request-supplied
destination. Keyless local models must use a literal `127.0.0.1` or `[::1]`
address in `WEBCRAWL_LLM_BASE_URL`. Other endpoints require HTTPS and use the
public-only transport. Model redirects are rejected and responses are bounded.
Do not put credentials in the endpoint URL. The stdio MCP process needs no HTTP
operator token; its caller already controls the local process and its stdin.

Run `npm test --ignore-scripts` for offline regression and localhost HTTP tests.
The two original public-web/real-Chromium integration tests require an installed
Chromium and explicit `WEBCRAWL_LIVE_TESTS=1`; they are skipped by default.

Full docs land as the gauntlet rounds close. See PROGRESS.html for live status.

License: MIT (original clean-room implementation; no Firecrawl code copied).
