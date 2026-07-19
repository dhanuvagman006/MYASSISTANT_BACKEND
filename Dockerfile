# MYASSISTANT_BACKEND — place this file in the repo root
#
# Two-stage build: better-sqlite3 is a NATIVE module, so the builder stage
# carries the C++ toolchain to compile it. The runtime stage copies the
# compiled node_modules and stays small (no compilers shipped).

# ---------- Stage 1: build native deps ----------
FROM node:20-alpine AS builder

# Toolchain for node-gyp (only exists in this stage)
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- Stage 2: runtime ----------
FROM node:20-alpine

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# SQLite user DB lives here — mount a volume at /app/data to persist it.
# Created before dropping root so the 'node' user can write to it.
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DATA_DIR=/app/data

# Don't run as root inside the container
USER node

ENV NODE_ENV=production
EXPOSE 3000

# Basic container health check against the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
