# Works on Pi 3 (ARMv7) and x86
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS base

WORKDIR /app
ENV NODE_ENV=production

# copy manifests
COPY package*.json ./

# prefer reproducible installs when lockfile is present
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# copy app code
COPY src ./src
COPY config ./config
COPY .env.example ./

EXPOSE 8080
CMD ["npm","start"]
