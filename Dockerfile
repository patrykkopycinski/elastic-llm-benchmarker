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

# Create non-root user for security
RUN groupadd -r benchmarker && useradd -r -g benchmarker benchmarker

WORKDIR /app

# Copy production dependencies and built artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/config ./config

# Create results directory and ensure ownership
RUN mkdir -p /app/results /app/data \
    && chown -R benchmarker:benchmarker /app

USER benchmarker

# Default environment
ENV NODE_ENV=production \
    PORT=3100 \
    LOG_LEVEL=info

# Healthcheck for the queue-server API
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3100)+'/health', (r) => r.statusCode===200 ? process.exit(0) : process.exit(1))" || exit 1

EXPOSE 3100

# Default: run the queue server API
CMD ["node", "dist/api/queue-server.js"]
