# ---------- Stage 1: Builder ----------
FROM node:20-slim AS builder

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first (cache-friendly)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build:ts

# Prune devDependencies for the runtime stage
RUN npm prune --production

# ---------- Stage 2: Runtime ----------
FROM node:20-slim AS runtime

# Install cloudflared (Tier-2 Buildkite tunnel fallback) and the gcloud CLI
# (GCP metadata / Secret Manager lookups from inside the controller VM).
# gcloud is installed via the upstream apt repository; cloudflared via the
# official Cloudflare binary. Both are optional at runtime — the daemon
# degrades gracefully when the binaries are absent.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        openssh-client \
        tini \
    && curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
        | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp.gpg] https://pkg.cloudflareclient.com/ bookworm main" \
        > /etc/apt/sources.list.d/cloudflared.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends cloudflared \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd -r benchmarker && useradd -r -g benchmarker benchmarker

WORKDIR /app

# Copy production dependencies and built artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/config ./config

# Container entrypoint: runs Queue API (background) + daemon (PID 1)
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Create results directory and ensure ownership
RUN mkdir -p /app/results /app/data \
    && chown -R benchmarker:benchmarker /app

USER benchmarker

# Default environment
# PORT 3200 — avoid 3100 (patryks-treadmill) per AGENTS.md.
# BENCHMARKER_CONFIG points at the GCP runtime config (placeholders only).
ENV NODE_ENV=production \
    PORT=3200 \
    LOG_LEVEL=info \
    BENCHMARKER_CONFIG=config/gcp.json

# Healthcheck for the queue-server API (the daemon's liveness is reflected
# via ES queue drain + scheduler heartbeat, surfaced through /health).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3200)+'/health', (r) => r.statusCode===200 ? process.exit(0) : process.exit(1))" || exit 1

EXPOSE 3200

# tini reaps zombie processes (the backgrounded API child); the entrypoint
# execs the daemon so it becomes PID 1 under tini and owns SIGTERM handling.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
