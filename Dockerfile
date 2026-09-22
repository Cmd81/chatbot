# syntax=docker/dockerfile:1

# ───────── ۱) ساخت فرانت (Vite) ─────────
FROM node:22-alpine AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ───────── ۲) ساخت بک‌اند (TypeScript) ─────────
FROM node:22-alpine AS backend
WORKDIR /src
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/ ./
RUN npm run build

# ───────── ۳) ایمیج نهایی ─────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=backend /src/dist ./dist
COPY --from=frontend /src/dist ./public

RUN addgroup -S app && adduser -S -G app app && chown -R app:app /app
USER app

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT:-3000}/livez" >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
