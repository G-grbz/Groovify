<div align="center">

[![CI](https://github.com/G-grbz/Gharmonize/actions/workflows/ci.yml/badge.svg)](https://github.com/G-grbz/Gharmonize/actions/workflows/ci.yml) [![CodeQL](https://github.com/G-grbz/Gharmonize/actions/workflows/codeql.yml/badge.svg)](https://github.com/G-grbz/Gharmonize/actions/workflows/codeql.yml)

<img width="1774" height="887"
     alt="Gharmonize & YTLive"
     src="https://github.com/user-attachments/assets/b0423223-7ae9-48e9-9450-2a2dbef91c1e" />

---

<details>
<summary><b>🎬 Watch Gharmonize Demo</b></summary>

<br>

https://github.com/user-attachments/assets/4083729e-3db9-4936-ac01-28c0f318aebe

</details>

---

### Download • Convert • Rip • Tag — with a Web UI + Desktop builds (AppImage/EXE)

Next-generation media processing, powered by **yt-dlp**, **FFmpeg** and **deno**.

Seamlessly download content from YouTube, YouTube Music, and major platforms like X, Facebook, Instagram, Vimeo, Dailymotion, and TikTok. Leverage Spotify, Apple Music, Deezer, TIDAL, and SoundCloud for intelligent metadata matching and track discovery — then fetch high-quality media via yt-dlp. Includes DRM-free disc ripping, iPhone / Android ringtone output, and blazing-fast GPU-accelerated transcoding, all powered by a robust and reliable processing engine.

> **Mapped-music note:** Spotify, Apple Music, Deezer, TIDAL, and SoundCloud are used as **metadata/catalog sources for matching and discovery**. Gharmonize matches supported catalog items to YouTube / YouTube Music for media retrieval and does **not** claim DRM bypass of subscription services.


</div>

---

## Official distribution and downloads

> [!IMPORTANT]
> The **only official Gharmonize source repository and release channel** is [`G-grbz/Gharmonize`](https://github.com/G-grbz/Gharmonize). Official desktop binaries are published through [GitHub Releases](https://github.com/G-grbz/Gharmonize/releases), and the official container image is published through [GitHub Container Registry](https://github.com/G-grbz/Gharmonize/pkgs/container/gharmonize).
>
> Repositories, websites, archives, or executables using the **Gharmonize** name outside these channels are **not official unless this repository explicitly says otherwise**. Never disable Windows Defender or another security product, add antivirus exclusions, or run an unrelated executable as Administrator just because a third-party page claims it is required for Gharmonize.

**Independent third-party listing:** [Softpedia – Gharmonize](https://www.softpedia.com/get/Multimedia/Audio/Other-AUDIO-Tools/Gharmonize.shtml) independently lists and reviews Gharmonize. This listing was created independently; it was **not requested, operated, or managed by the Gharmonize project**. Use the official GitHub release page, `SHA256SUMS`, and GitHub artifact attestations when you need to verify a release.

For guidance on unofficial downloads, impersonation, and reporting suspicious distributions, see [SECURITY.md](SECURITY.md). For use of the Gharmonize name and logo, see [TRADEMARK.md](TRADEMARK.md).

---

## Quick Start

> **Prebuilt desktop builds:** Official Gharmonize **Windows EXE** and **Linux AppImage** releases already include the Node.js runtime required by the application through Electron. You **do not need to install Node.js separately** to use these packaged builds. Some third-party download sites may incorrectly list Node.js as an additional prerequisite; that notice can be ignored for official prebuilt Gharmonize binaries. Node.js is only required when running or building Gharmonize from source.

**Local / Desktop (from source)**

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize

BUILD_ELECTRON=1 npm i
npm start
```

Then open **http://localhost:5174**

Gharmonize checks runtime binaries (ffmpeg, ffprobe, mkvmerge, yt-dlp, deno) at startup and downloads or refreshes them automatically when needed.

For packaged AppImage/EXE builds and full installation details, see [docs/INSTALLATION.md](docs/INSTALLATION.md).

### Docker

Gharmonize can run from the official **GitHub Container Registry (GHCR)** image or be built locally from source. The default/local Compose configuration does **not** request the NVIDIA runtime.

**Official image:** [`ghcr.io/g-grbz/gharmonize`](https://github.com/G-grbz/Gharmonize/pkgs/container/gharmonize)

```bash
docker pull ghcr.io/g-grbz/gharmonize:latest
docker compose pull
docker compose up -d
```

Release versions are also published with versioned tags such as `ghcr.io/g-grbz/gharmonize:1.3.8`, allowing deployments to pin a specific Gharmonize release instead of tracking `latest`.

**Local source build**

```bash
docker compose -f docker-compose.local.yml up -d --build
```

**Local source build with NVIDIA / NVENC**

```bash
docker compose \
  -f docker-compose.local.yml \
  -f docker-compose-local-nvidia.yml \
  up -d --build
```

> **Important:** `docker-compose-local-nvidia.yml` is an **override**, not a standalone Compose stack. Always load it **after** `docker-compose.local.yml`. It adds the NVIDIA-specific settings (`gpus: all`, NVIDIA runtime/environment, root user, and privileged mode) to the base `web` service. Do **not** run the NVIDIA override by itself. Without the override, the local Compose stack does not request NVIDIA devices or the NVIDIA container runtime.

Docker runtime binaries (FFmpeg, FFprobe, MKVToolNix, yt-dlp, and Deno) are checked at startup and cached under `/opt/gharmonize/cache`; missing or outdated managed binaries can be refreshed automatically. On a new Docker installation, the generated initial admin password is stored at `/opt/gharmonize/cache/INITIAL_ADMIN_PASSWORD.txt`.

Full Docker setup, bind mounts, permissions, `MUSIC_DIR`, NVIDIA Container Toolkit requirements, and `docker run` examples are documented in [docs/DOCKER.md](docs/DOCKER.md).

---

## What You Get

- **YouTube / YouTube Music** downloads for single items, playlists, and mixes
- **YTLive** — a dedicated music-first UI for YouTube discovery, playback, and queueing
- **X (Twitter) / Facebook / Instagram / Vimeo / Dailymotion / TikTok** download and conversion flows
- **Spotify, Apple Music, Deezer, TIDAL, and SoundCloud** mapped-music workflows with safer YouTube candidate ranking and duration-aware validation
- **TIDAL** track / playlist / album mapping, including album-track URLs and paginated collections
- **SoundCloud** tracks, sets/playlists, profile collections such as `popular-tracks`, plus supported discovery and station-style URLs
- **Phone ringtone output** for iPhone (`.m4r`) and Android (`.mp3`)
- **Audio and video conversion** powered by FFmpeg, with FPS/A-V sync presets for AC3 / EAC3 / AAC
- **GPU acceleration** for local transcoding — NVENC, VAAPI, Intel QSV
- **DRM-free disc ripping** with stream selection in the Web UI
- **Runtime binary management** for ffmpeg, ffprobe, mkvmerge, yt-dlp, and deno
- **Job engine** for batch processing, progress tracking, and reliability

Full details in [docs/FEATURES.md](docs/FEATURES.md).

---

## Documentation

| Guide | Description |
| --- | --- |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Requirements, local/desktop setup, build commands |
| [docs/DOCKER.md](docs/DOCKER.md) | Docker Compose, Docker run, NVIDIA/NVENC |
| [docs/FEATURES.md](docs/FEATURES.md) | Full feature list and supported sources |
| [docs/YTLIVE.md](docs/YTLIVE.md) | YTLive music UI guide |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Full `.env` variable reference |
| [docs/BINARY_MANAGEMENT.md](docs/BINARY_MANAGEMENT.md) | ffmpeg / yt-dlp / deno binary handling |
| [docs/COOKIES.md](docs/COOKIES.md) | Cookies, age-restricted content, environment comparison |
| [docs/HOMEPAGE_WIDGET.md](docs/HOMEPAGE_WIDGET.md) | Homepage dashboard widget setup |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common issues & fixes |
| [LICENSE.md](LICENSE.md) | GPL-3.0 license & redistribution rules |
| [TRADEMARK.md](TRADEMARK.md) | Gharmonize name, logo, and branding policy |
| [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) | Bundled third-party tool licenses |

---

## Companion Tool: G-TMCE

For users who want a more advanced MKV finishing workflow after ripping or extracting DRM-free media, check out **G-TMCE**:

🔗 https://github.com/G-grbz/G-TMCE

G-TMCE is a cross-platform MKV creation and extraction GUI for Linux and Windows. It focuses on professional remux workflows with TMDB metadata, automatic `tags.xml` generation, artwork downloads, chapter generation, language-aware audio/subtitle handling, forced/SDH subtitle detection, and MKVToolNix automation.

Gharmonize is designed for downloading, conversion, ripping, tagging, and batch processing. G-TMCE can be used as a companion tool when you want to prepare polished MKV outputs for media libraries and home media servers.

---

## Disclaimer

This software is provided "as is", without warranty of any kind. Use it at your own risk.

---

## License

Gharmonize is licensed under the **GPL-3.0 license**.

- Full terms and redistribution rules: [LICENSE.md](LICENSE.md)
- Licenses for bundled third-party tools (FFmpeg, MKVToolNix, yt-dlp, deno): [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)


## Security and release verification

Gharmonize uses scrypt admin password hashing, AES-256-GCM encryption for supported sensitive settings, configurable server-side application access gating with optional administrator-approved temporary sessions, loopback-by-default native serving, trusted-proxy CIDR validation, SSRF/path hardening, Electron sandbox/IPC restrictions, and runtime-binary origin/digest checks. See [SECURITY.md](SECURITY.md) for the reporting policy and deployment notes.

Official tagged releases are built by GitHub Actions for Windows and Linux and publish Windows NSIS/portable artifacts, a Linux AppImage, a source archive, CycloneDX SBOM, a GPG-signed `SHA256SUMS` manifest, the public release-signing key, and GitHub artifact attestations.

```bash
# First authenticate the published release key against the official repository provenance.
gh attestation verify Gharmonize-release-signing-key.asc --repo G-grbz/Gharmonize

# Import the authenticated public key and verify the signed checksum manifest.
gpg --import Gharmonize-release-signing-key.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS

# You can also verify any individual artifact directly against GitHub provenance.
gh attestation verify <artifact> --repo G-grbz/Gharmonize
```
