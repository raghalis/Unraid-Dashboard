# Works on Pi 3 (ARMv7) and x86
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS base

WORKDIR /app
ENV NODE_ENV=production

# Install only needed packages
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY config ./config
COPY .env.example ./
# secrets are provided at runtime via docker secrets/volume

EXPOSE 8080
CMD ["npm","start"]
