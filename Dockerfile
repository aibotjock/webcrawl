# webcrawl — standalone search + crawl server (HTTP API, Exa-compatible routes, WebUI).
# Host-agnostic: Railway, Fly, Render, a VPS, or `docker run` on your own machine.
# The Playwright image ships Chromium and its system libraries; keep its tag in step
# with the playwright version in package-lock.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    WEBCRAWL_CACHE_DIR=/data/pages \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY webui ./webui

# Page cache lives on a volume so the instant level survives restarts.
RUN mkdir -p /data/pages && chown -R pwuser:pwuser /data
VOLUME ["/data"]
EXPOSE 8787
USER pwuser
CMD ["node", "src/server.js"]
