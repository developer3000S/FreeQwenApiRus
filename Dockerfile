# syntax=docker/dockerfile:1.6
FROM node:20-slim AS base

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium fonts-liberation libatk-bridge2.0-0 libatk1.0-0 \
      libcups2 libdrm2 libgbm1 libnss3 libxcomposite1 \
      libxdamage1 libxrandr2 xdg-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/session /app/logs /app/uploads \
 && useradd -m appuser \
 && chown -R appuser:appuser /app

USER appuser

EXPOSE 3264

CMD ["node", "index.js"]
