# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /usr/src/app

RUN set -eux; \
    apk add --no-cache ffmpeg curl python3 ca-certificates tzdata; \
    update-ca-certificates; \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp; \
    chmod a+rx /usr/local/bin/yt-dlp; \
    echo "yt-dlp version:" && /usr/local/bin/yt-dlp --version; \
    echo "ffmpeg version:" && ffmpeg -version

COPY package*.json ./
RUN set -eux; \
    export NPM_CONFIG_LOGLEVEL=warn; \
    export NPM_CONFIG_IGNORE_SCRIPTS=true; \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi; \
    npm cache clean --force

COPY . .

ENV NODE_ENV=production \
    PORT=5174 \
    YTDLP_BIN=/usr/local/bin/yt-dlp

RUN mkdir -p uploads outputs temp cookies && chmod -R 0775 /usr/src/app

EXPOSE 5174
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5174/ >/dev/null || exit 1

CMD ["node", "app.js"]
