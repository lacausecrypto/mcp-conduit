# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies so the production stage is smaller
RUN npm prune --omit=dev


# ── Stage 2: Production ────────────────────────────────────────────────────────
FROM node:22-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 conduit && adduser -u 1001 -G conduit -s /bin/sh -D conduit

WORKDIR /app

# Copy only what is needed to run
COPY --from=builder --chown=conduit:conduit /app/node_modules ./node_modules
COPY --from=builder --chown=conduit:conduit /app/dist ./dist
COPY --chown=conduit:conduit package.json ./

# Create a directory for the SQLite database with correct permissions
RUN mkdir -p /data && chown conduit:conduit /data

USER conduit

# Default environment — override at runtime
ENV CONDUIT_DB_PATH=/data/conduit-logs.db
ENV NODE_ENV=production

EXPOSE 8080
EXPOSE 9090

# Kubernetes liveness probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/conduit/health | grep -q '"status"' || exit 1

CMD ["node", "dist/index.js"]
