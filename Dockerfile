# Rendley MCP server — CPU-only (SwiftShader software WebGL) Chromium.
#
# Runtime config is via environment variables (see .env.example). Rendering runs
# on SwiftShader software WebGL — no GPU passthrough required, so the image works
# on any host. The browser runs as the unprivileged `pwuser` account with
# Chromium's sandbox enabled; the compose file drops capabilities and sets
# no-new-privileges.

# Must match the `playwright` package version in package.json — the image ships
# the matching browsers and the build reuses them (bump both together).
FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS base

# System libs for GPU/codec paths.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    ffmpeg \
    libglvnd0 \
    libgl1 \
    libglx0 \
    libegl1 \
    libxext6 \
    libx11-6 \
    libgbm1 \
    libdrm2 \
    mesa-va-drivers \
    mesa-vdpau-drivers \
    vainfo \
  && rm -rf /var/lib/apt/lists/*

# Bun is the runtime — runs TypeScript directly, no tsc build.
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

# google-chrome-stable gives the Playwright "chrome" channel its proprietary
# H.264/AAC codecs (bundled Chromium lacks them). amd64-only — Chrome has no
# arm64 Linux build, so on arm64 it's skipped and the launcher falls back to
# bundled Chromium (run with USE_CHROME_CHANNEL=false).
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
      && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
      && apt-get update \
      && apt-get install -y --no-install-recommends google-chrome-stable \
      && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "skipping google-chrome on $(dpkg --print-architecture) — run with USE_CHROME_CHANNEL=false"; \
    fi

WORKDIR /app

# Dependencies first for layer caching.
COPY package.json bun.lock ./
# Base image already has the browsers; skip Playwright's download (also makes the
# package postinstall self-skip via its guard).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

RUN mkdir -p /var/cache/rendley-mcp \
  && chown -R pwuser:pwuser /app /var/cache/rendley-mcp

USER pwuser

# All runtime config travels via environment variables (see .env.example).
# These defaults make a freshly-pulled image usable; override per-deployment.
ENV PORT=8787 \
    HEADLESS=true \
    CPU_ONLY=true \
    QUEUE_CONCURRENCY=4 \
    QUEUE_MAX_QUEUED=30 \
    USE_CHROME_CHANNEL=true \
    BROWSER_RECYCLE_AFTER=8 \
    CHROMIUM_JS_HEAP_MB=512 \
    LIBGL_ALWAYS_INDIRECT=0

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8787}/health" || exit 1

CMD ["bun", "--preload", "./src/instrumentation.ts", "src/index.ts"]
