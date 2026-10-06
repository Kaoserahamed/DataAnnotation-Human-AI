# ─── Build stage ────────────────────────────────────────────────────────────
FROM node:20.11.0-alpine AS base

WORKDIR /app

# Copy manifests first so Docker layer-caching skips npm ci on code-only changes
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json          ./apps/api/

RUN npm ci --prefer-offline

# Copy source
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
COPY tsconfig.base.json ./

# ─── Production image ────────────────────────────────────────────────────────
FROM base AS production

WORKDIR /app

ENV NODE_ENV=production

EXPOSE 4000

CMD ["node", "--import", "tsx/esm", "apps/api/src/index.ts"]

# ─── Development image (default target) ──────────────────────────────────────
FROM base AS development

WORKDIR /app

ENV NODE_ENV=development

EXPOSE 4000

CMD ["node", "--import", "tsx/esm", "--watch", "apps/api/src/index.ts"]
