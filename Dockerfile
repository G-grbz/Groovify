FROM node:20-alpine
WORKDIR /usr/src/app

RUN set -eux; \
    apk add --no-cache ffmpeg curl python3 ca-certificates; \
    update-ca-certificates; \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp; \
    chmod a+rx /usr/local/bin/yt-dlp; \
    /usr/local/bin/yt-dlp --version; \
    ffmpeg -version

COPY package*.json ./

RUN set -eux; \
  if [ -f package-lock.json ]; then \
    npm ci --omit=dev; \
  elif [ -f yarn.lock ]; then \
    corepack enable; yarn install --production; \
  elif [ -f pnpm-lock.yaml ]; then \
    corepack enable; pnpm install --prod; \
  else \
    npm install --omit=dev; \
  fi; \
  npm cache clean --force

COPY . .

ENV NODE_ENV=production \
    PORT=5174

RUN mkdir -p uploads outputs temp \
 && chmod -R 0775 /usr/src/app

EXPOSE 5174
CMD ["node", "app.js"]
