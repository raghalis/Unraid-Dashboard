# Multi-arch friendly; swap to node:18-bullseye-slim if arm/v7 issues
FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY .env.example ./
COPY README.md ./

EXPOSE 8080
CMD ["npm","start"]
