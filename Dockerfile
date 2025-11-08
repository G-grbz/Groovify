# syntax=docker/dockerfile:1
FROM node:20-alpine AS base

WORKDIR /usr/src/app

RUN set -eux; \
    apk add --no-cache ffmpeg curl python3 ca-certificates; \
    update-ca-certificates; \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp; \
    chmod a+rx /usr/local/bin/yt-dlp; \
    /usr/local/bin/yt-dlp --version; \
    ffmpeg -version

COPY package.json package-lock.json* ./

RUN set -eux; \
  export NPM_CONFIG_LOGLEVEL=warn; \
  export NPM_CONFIG_IGNORE_SCRIPTS=true; \
  if [ -f package-lock.json ]; then \
    npm ci --omit=dev; \
  else \
    npm install --omit=dev; \
  fi; \
  npm cache clean --force

COPY app.js ./app.js
COPY config.js ./config.js
COPY .env.default ./.env.default
COPY routes ./routes
COPY modules ./modules
COPY public ./public

ENV NODE_ENV=production \
    PORT=5174 \
    ENV_DEFAULT_PATH=/usr/src/app/.env.default

RUN mkdir -p uploads outputs temp cookies \
 && chmod -R 0775 /usr/src/app

EXPOSE 5174
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:5174/ >/dev/null 2>&1 || exit 1
CMD ["node", "app.js"]
