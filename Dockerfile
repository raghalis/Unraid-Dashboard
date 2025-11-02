# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base
WORKDIR /app

ARG APP_VERSION=0.0.0
ENV APP_VERSION=${APP_VERSION} NODE_ENV=production
RUN echo -n "${APP_VERSION}" > /app/version.txt

# Optional helpers
RUN apk add --no-cache tini tzdata

# Copy manifests first (cache-friendly)
COPY package*.json ./

# Prefer reproducible installs, fallback gracefully if lock is missing/bad
RUN --mount=type=cache,target=/root/.npm \
    set -eux; \
    if [ -f package-lock.json ]; then \
      echo ">> Using npm ci (lockfile present)"; \
      npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund; \
    else \
      echo ">> No package-lock.json found; falling back to npm install"; \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# Copy the rest
COPY . .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/sbin/tini","--"]
CMD ["npm","start"]