# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS base
WORKDIR /app

# Accept the app version from CI (no "v" prefix)
ARG APP_VERSION=0.0.0
ENV APP_VERSION=${APP_VERSION}

# Write a version file that server can read even if envs are scrubbed by proxy
RUN echo -n "${APP_VERSION}" > /app/version.txt

# Install deps separately for better caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy app
COPY . .

# (optional) if you have a client build step, do it here:
# RUN npm run build

EXPOSE 8080
ENV NODE_ENV=production

CMD ["npm", "start"]
