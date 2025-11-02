# 🎵 Groovify – YouTube / Spotify Downloader & Converter

> **(English + Türkçe)**

---

# 🇬🇧 English Version

## 📘 Table of Contents

* [Overview](#overview)
* [Features](#features)
* [Requirements](#requirements)
* [Environment Variables (.env)](#environment-variables-env)
* [Quick Start (Local – Node & npm)](#quick-start-local--node--npm)
* [Quick Start (Docker Compose)](#quick-start-docker-compose)
* [Notes & Troubleshooting](#notes--troubleshooting)
* [License](#license)

---

## Overview

**Groovify** is a Node.js + ffmpeg powered server that can:

* Parse YouTube / YouTube Music links (single, playlist, automix)
* Map Spotify tracks, playlists, and albums to YouTube and download
* Convert to **mp3 / flac / wav / ogg**, or save **mp4** without re-encoding
* Embed tags & cover art when available
* Provide a minimal web UI and JSON API

---

## Features

* **yt-dlp** integration (SABR / 403 workarounds)
* **ffmpeg** conversion with reliability
* **Multer** for file uploads
* **Docker** image & Compose setup
* **Spotify Web API** support (playlist / album / track)
* **Settings API** for runtime config changes

---

## Requirements

| Requirement      | Version  | Description              |
| ---------------- | -------- | ------------------------ |
| Node.js          | >= 20    | Required                 |
| ffmpeg           | Any      | Included in Docker image |
| yt-dlp           | Latest   | Included in Docker image |
| Spotify API Keys | Optional | For Spotify mapping      |

---

## Environment Variables (.env)

Create a `.env` file in the project root:

```dotenv
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# YouTube behavior
YT_USE_MUSIC=1
YT_FORCE_IPV4=1
YT_403_WORKAROUNDS=0
YT_LANG=en-US
YT_DEFAULT_REGION=
YT_ACCEPT_LANGUAGE="en-US,en;q=0.8"

# yt-dlp tweaks
YTDLP_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
YTDLP_COOKIES=./cookies/cookies.txt
YTDLP_COOKIES_FROM_BROWSER=chrome
YTDLP_EXTRA="--http-chunk-size 16M --concurrent-fragments 1"
YT_STRIP_COOKIES=1

# App auth & behavior
ADMIN_PASSWORD=123456
APP_SECRET=
PREFER_SPOTIFY_TAGS=1
TITLE_CLEAN_PIPE=1

# Spotify region preferences
SPOTIFY_MARKET=US
SPOTIFY_FALLBACK_MARKETS=TR,GB,DE,FR

# Server
PORT=5174
```

---

## Quick Start (Local – Node & npm)

1. Install dependencies:

   ```bash
   npm i express multer node-fetch spotify-web-api-node dotenv archiver && npm i -D nodemon
   ```
2. Start the app:

   ```bash
   npm start
   ```
3. Open: [http://localhost:5174](http://localhost:5174)

---

## Quick Start (Docker Compose)


```yaml
services:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    image: groovify:prod
    container_name: Groovify
    env_file: .env
    environment:
      - NODE_ENV=production
      - PORT=5174
      - YT_FORCE_IPV4=1
      - YTDLP_EXTRA=--force-ipv4
    ports:
      - "5174:5174"
    volumes:
      - ./uploads:/usr/src/app/uploads
      - ./outputs:/usr/src/app/outputs
      - ./temp:/usr/src/app/temp
      - ./cookies/cookies.txt:/usr/src/app/cookies/cookies.txt:ro
    restart: unless-stopped
```

Run:

```bash
docker compose up -d --build
```

---


## Notes & Troubleshooting

* **yt-dlp not found** → Install yt-dlp or use Docker image.
* **403 / SABR issues** → Adjust flags like `--http-chunk-size`, use cookies if needed.
* **Spotify personalized Mix not supported** → Copy items to a normal playlist.
* **Uploads limit** → 100MB max (configurable in `app.js`).

---

## License

**MIT License**
This project is licensed under the MIT License.

You are free to use, copy, modify, merge, publish, and distribute this software, provided that:

You credit the original author clearly.

A link to the original repository is included when possible.

Any modifications or changes are clearly indicated.

This software is provided “as is”, without warranty of any kind. Use it at your own responsibility.

---

# 🇹🇷 Türkçe Versiyon

## 📘 İçindekiler

* [Genel Bakış](#genel-bakış)
* [Özellikler](#özellikler)
* [Gereksinimler](#gereksinimler)
* [Ortam Değişkenleri (.env)](#ortam-değişkenleri-env)
* [Hızlı Başlangıç (Yerel – Node & npm)](#hızlı-başlangıç-yerel--node--npm)
* [Hızlı Başlangıç (Docker Compose)](#hızlı-başlangıç-docker-compose)
* [Notlar ve Sorun Giderme](#notlar-ve-sorun-giderme)
* [Lisans](#lisans)

---

## Genel Bakış

**Groovify**, Node.js + ffmpeg tabanlı bir sunucudur ve:

* YouTube / YouTube Music bağlantılarını (tek video, oynatma listesi, automix) işler
* Spotify parça, albüm ve oynatma listelerini YouTube’a eşleyip indirir
* **mp3 / flac / wav / ogg** formatlarına dönüştürür veya **mp4**’ü yeniden encode etmeden kaydeder
* Etiket ve kapak görseli ekler (uygunsa)
* Basit bir web arayüzü ve JSON API sunar

---

## Özellikler

* **yt-dlp** entegrasyonu (SABR / 403 hataları için çözümler)
* **ffmpeg** ile güvenilir dönüştürme
* **Multer** ile dosya yükleme
* **Docker** imajı ve Compose kurulumu
* **Spotify Web API** desteği (oynatma listesi, albüm, parça)
* **Settings API** ile çalışma anında yapılandırma değişikliği

---

## Gereksinimler

| Gereksinim              | Sürüm     | Açıklama                |
| ----------------------- | --------- | ----------------------- |
| Node.js                 | >= 20     | Gerekli                 |
| ffmpeg                  | Herhangi  | Docker imajında dahil   |
| yt-dlp                  | Güncel    | Docker imajında dahil   |
| Spotify API Anahtarları | Opsiyonel | Spotify eşleştirme için |

---

## Ortam Değişkenleri (.env)

Proje kök dizininde `.env` dosyası oluşturun:

```dotenv
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
YT_USE_MUSIC=1
YT_FORCE_IPV4=1
YT_403_WORKAROUNDS=0
YT_LANG=en-US
YT_DEFAULT_REGION=
YT_ACCEPT_LANGUAGE="en-US,en;q=0.8"
YTDLP_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
YTDLP_COOKIES=./cookies/cookies.txt
YTDLP_COOKIES_FROM_BROWSER=chrome
YTDLP_EXTRA="--http-chunk-size 16M --concurrent-fragments 1"
YT_STRIP_COOKIES=1
ADMIN_PASSWORD=123456
APP_SECRET=
PREFER_SPOTIFY_TAGS=1
TITLE_CLEAN_PIPE=1
SPOTIFY_MARKET=US
SPOTIFY_FALLBACK_MARKETS=TR,GB,DE,FR
PORT=5174
```

---

## Hızlı Başlangıç (Yerel – Node & npm)

1. Gerekli bağımlılıkları yükleyin:

   ```bash
   npm i express multer node-fetch spotify-web-api-node dotenv archiver && npm i -D nodemon
   ```
2. Uygulamayı başlatın:

   ```bash
   npm start
   ```
3. Tarayıcıda açın: [http://localhost:5174](http://localhost:5174)

---

## Hızlı Başlangıç (Docker Compose)

```
services:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    image: groovify:prod
    container_name: Groovify
    env_file: .env
    environment:
      - NODE_ENV=production
      - PORT=5174
      - YT_FORCE_IPV4=1
      - YTDLP_EXTRA=--force-ipv4
    ports:
      - "5174:5174"
    volumes:
      - ./uploads:/usr/src/app/uploads
      - ./outputs:/usr/src/app/outputs
      - ./temp:/usr/src/app/temp
      - ./cookies/cookies.txt:/usr/src/app/cookies/cookies.txt:ro
    restart: unless-stopped
```

Çalıştırın:

```bash
docker compose up -d --build
```

---

## Notlar ve Sorun Giderme

* **yt-dlp bulunamadı** → Yerel kullanımda yt-dlp kurulu olmalı.
* **403 / SABR hataları** → `YTDLP_EXTRA` veya çerez kullanımı işe yarar.
* **Spotify kişiselleştirilmiş Mix** → API desteklemez, oynatma listesine dönüştürün.
* **Yükleme sınırı** → 100MB, `app.js` üzerinden değiştirilebilir.

---

## Lisans

**MIT Lisansı**
Orijinal yazar belirtilmek şartıyla kullanma, değiştirme ve dağıtım serbesttir. Bu yazılım, hiçbir garanti olmaksızın "olduğu gibi" sunulmaktadır. Yazılımı kullanmak kendi sorumluluğunuzdadır.
