# MYASSISTANT_BACKEND — place this file in the repo root
FROM node:20-alpine

WORKDIR /app

# Install deps first so Docker caches this layer between code changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY src ./src

# Don't run as root inside the container
USER node

ENV NODE_ENV=production
EXPOSE 3000

# Basic container health check against the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
