# MYASSISTANT_BACKEND — place this file in the repo root
#
# Base: node:20-slim (Debian/glibc), NOT alpine. Reason: better-sqlite3 is
# a native module with PREBUILT binaries for glibc — on slim it installs
# instantly with zero compilation. On alpine (musl) there is no prebuilt
# binary, so node-gyp must compile from source AND download Node headers
# from unofficial-builds.nodejs.org — which fails on flaky networks
# (ETIMEDOUT) and adds minutes to every build. Slim is ~40 MB larger and
# completely reliable; that is the right trade for a production API.

# ---------- Stage 1: install deps (prebuilt, no toolchain needed) ----------
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- Stage 2: runtime ----------
FROM node:20-slim

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# SQLite user DB lives here — mount a volume at /app/data to persist it.
# Created before dropping root so the 'node' user can write to it.
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DATA_DIR=/app/data

# Don't run as root inside the container
USER node

ENV NODE_ENV=production
EXPOSE 3000

# Health check via node itself — slim ships no wget/curl, and adding one
# just for this would grow the image.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
