# syntax=docker/dockerfile:1.7

###############################################################################
# Unraid Control Panel - Dockerfile
# - Bakes APP_VERSION into ENV and /app/version.txt
# - Robust dependency install: prefer `npm ci`, fallback to `npm install`
# - Cache-friendly layers
###############################################################################

FROM node:20-alpine AS base
WORKDIR /app

# ------------------------ Build args / version wiring ------------------------
ARG APP_VERSION=0.0.0
ENV APP_VERSION=${APP_VERSION}
# Write a version file so the server can read it even if envs are scrubbed by a proxy
RUN echo -n "${APP_VERSION}" > /app/version.txt

# Optional: if you sometimes pull in native deps, uncomment the next line
# RUN apk add --no-cache python3 make g++

# --------------------------- Dependency installation -------------------------
# Copy only manifests for better cache reuse
# (This copies package.json and, if present, package-lock.json)
COPY package*.json ./

# Prefer reproducible installs with npm ci, but gracefully fallback to npm install
# - Uses an npm cache mount for speed on rebuilds
RUN --mount=type=cache,target=/root/.npm \
    set -eux; \
    if [ -f package-lock.json ]; then \
      echo ">> Using npm ci (lockfile present)"; \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      echo ">> No package-lock.json found; falling back to npm install"; \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# ------------------------------- App contents --------------------------------
# Now copy the rest of the source
COPY . .

# If you have a frontend build step (e.g., bundling web assets), do it here:
# RUN npm run build

# ------------------------------ Runtime config -------------------------------
ENV NODE_ENV=production
EXPOSE 8080

# (Optional) basic healthcheck; adjust path/timeout as desired
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["npm", "start"]
