# CloudNest Enterprise Multi-Stage Dockerfile
# Stage 1: Build Application
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Install native build tools for better-sqlite3 compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Production Runtime
FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    CLOUDNEST_DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root service user for container hardening
RUN groupadd -g 1001 cloudnest && \
    useradd -u 1001 -g cloudnest -s /bin/bash -m cloudnest && \
    mkdir -p /data && chown -R cloudnest:cloudnest /data /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy pre-compiled production artifacts from builder
COPY --from=builder --chown=cloudnest:cloudnest /app/dist ./dist
COPY --from=builder --chown=cloudnest:cloudnest /app/scripts ./scripts
COPY --from=builder --chown=cloudnest:cloudnest /app/server/src ./server/src

USER cloudnest
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://127.0.0.1:8787/api/health || exit 1

CMD ["node", "dist/server/src/index.js"]
