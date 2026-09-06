# YTLive Music UI

YTLive is a dedicated music interface for YouTube and YouTube Music. It is available alongside the classic Gharmonize UI and focuses on search, playback, playlist inspection, and fast queueing into the existing conversion pipeline.

<img width="1684" height="934" alt="YTLive Screenshot" src="https://github.com/user-attachments/assets/34945652-9c72-4bc6-9c78-b01302aba81b" />

---

## Opening YTLive

Open it directly:

- `http://localhost:5174/ytlive.html`

You can also switch from the classic UI with the **YTLive** toolbar button. From YTLive, use the **Classic UI** sidebar link to return to the original interface.

To make YTLive the default page served from `/`, set in your `.env`:

```dotenv
FRONTEND_UI=ytlive
```

---

## What YTLive Supports

- YouTube search with track / playlist / album filters
- Discovery presets and infinite loading
- Quick play or queue by pasted YouTube / YouTube Music URL
- Embedded playback plus an "Open on YouTube" fallback for videos that block embeds
- Output controls for format, quality, sample rate, lyrics, ZIP creation, and playlist concurrency
- Playlist preview with individual track add buttons
- YouTube Music home shelves when cookies are available
- Live queue status through `/api/queue/status`

---

## Playlist Quick-Add Limit

Playlist quick-add is capped by `YOUTUBE_QUICK_ADD_LIMIT`. Set it between `1` and `100` to control how many playlist entries the YTLive playlist **+** action queues at once. See [CONFIGURATION.md](CONFIGURATION.md).

---

## YouTube Music Home Shelves

Personal YouTube Music shelves require a usable cookie source — either `cookies.txt` or browser cookie extraction on a local / desktop install.

- Docker can use `cookies.txt`, but **cannot** extract cookies from a host browser profile inside the container.

For full details on cookie behavior across environments, see [COOKIES.md](COOKIES.md).

## Shared Server Cache and Request Limits

All browsers connected to the **same Gharmonize server** share its YouTube Music
cache and in-flight loads. Changing the visible shelf count or discovery page size
reuses already-fetched content; missing personal shelves resume from a private
continuation checkpoint. Changing a layout setting does not force a fresh feed.

The server stores a bounded snapshot at `DATA_DIR/cache/youtube-music-cache.json`
(or `cache/youtube-music-cache.json` under the working directory when `DATA_DIR`
is unset). The snapshot is written atomically with owner-only file permissions on
Unix. It contains recommendations and continuation checkpoints, **not raw cookies
or authorization headers**. Session hashes, account indexes and locales separate
personal feeds. Treat the cache as private application data.

- Personal Home stays fresh for 10 minutes by default. Expired data can remain
  visible during refresh or upstream failures for up to 24 hours.
- Discovery results and query pools stay fresh for 15 minutes by default.
- Partial loads remain resumable; temporary failures use a short shared retry
  delay, rather than marking an incomplete feed complete.
- Explicit Home refreshes share in-flight work and have a 30-second server-side
  cooldown. Ordinary browser reloads reuse fresh data.
- The Home, discovery and music-search JSON API flows share two request slots
  and a 500 ms minimum start interval. HTTP 429 is not immediately retried:
  `Retry-After` is respected, or a five-minute cooldown is used when absent.
  The cooldown is shared across browsers and persisted across restarts.

Optional environment settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `YTM_SHARED_CACHE_PERSIST` | `1` | Set to `0` for memory-only caching. |
| `YTM_HOME_RESULT_CACHE_TTL_MS` | `600000` | Personal Home freshness. |
| `YOUTUBE_DISCOVER_CACHE_TTL_MS` | `900000` | Discovery freshness. |
| `YTM_API_MIN_INTERVAL_MS` | `500` | Minimum gap between API load starts. |
| `YTM_PARTIAL_RETRY_DELAY_MS` | `5000` | Shared retry delay after partial Home errors. |

If the data volume is read-only, memory caching still works, but does not survive
restart. Separate desktop processes/containers do not share a live request queue;
use one server for multiple browsers. Do not point independent server processes
at the same snapshot file as a substitute for a distributed cache.

These controls reduce unnecessary API traffic; they cannot guarantee that YouTube
will never rate-limit an IP address or account. They do not control yt-dlp download
jobs, embedded browser playback, GiG, or other applications using the same public IP.
