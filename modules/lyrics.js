import fs from "fs";
import path from "path";
import { getCache, setCache } from "./cache.js";

const LYRICS_CACHE_TTL = 24 * 60 * 60 * 1000;
function emitLog(onLog, payload) {
  if (payload?.fallback) console.log(payload.fallback);
  if (onLog) onLog(payload);
}

export class LyricsFetcher {
  constructor() {
    this.baseURL = "https://lrclib.net/api";
  }

  async searchLyrics(artist, title, duration = null, options = {}) {
    const { onLog = null } = options;
    const cacheKey = `lyrics_${artist}_${title}_${duration}`;

    const searchLogMsg = {
      logKey: "log.lyrics.searching",
      logVars: { artist, title },
      fallback: `🔍 Şarkı sözleri aranıyor: "${artist}" - "${title}"`,
    };
    emitLog(onLog, searchLogMsg);

    const cached = getCache(cacheKey);
    if (cached && Date.now() - cached.timestamp < LYRICS_CACHE_TTL) {
      const cachedLogMsg = {
        logKey: "log.lyrics.cached",
        logVars: { title },
        fallback: `✅ Önbellekten yüklendi: ${title}`,
      };
      emitLog(onLog, cachedLogMsg);
      return cached.data;
    }

    try {
      const params = new URLSearchParams({
        artist_name: artist,
        track_name: title,
      });

      if (duration) {
        params.append("duration", Math.round(duration));
      }

      const apiUrl = `${this.baseURL}/get?${params}`;
      console.log(`🌐 LRCLib API çağrısı: ${apiUrl}`);

      const response = await fetch(apiUrl);

      if (!response.ok) {
        if (response.status === 404) {
          const notFoundLogMsg = {
            logKey: "log.lyrics.notFound",
            logVars: { title },
            fallback: `❌ Şarkı sözleri bulunamadı: ${title}`,
          };
          emitLog(onLog, notFoundLogMsg);
          return null;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      console.log("📄 API yanıtı:", data ? "Veri alındı" : "Boş yanıt");

      if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
        const noContentLogMsg = {
          logKey: "log.lyrics.noContent",
          logVars: { title },
          fallback: `❌ Geçerli söz içeriği yok: ${title}`,
        };
        emitLog(onLog, noContentLogMsg);
        return null;
      }

      setCache(cacheKey, {
        data: data,
        timestamp: Date.now(),
      });

      const foundLogMsg = {
        logKey: "log.lyrics.found",
        logVars: { title },
        fallback: `✅ Şarkı sözleri bulundu: ${title}`,
      };
      emitLog(onLog, foundLogMsg);
      return data;
    } catch (error) {
      const errorLogMsg = {
        logKey: "log.lyrics.error",
        logVars: { artist, title, err: error.message },
        fallback: `❌ Şarkı sözleri aranırken hata oluştu (${artist} - ${title}): ${error.message}`,
      };
      emitLog(onLog, errorLogMsg);
      return null;
    }
  }

  async downloadLyrics(artist, title, duration = null, outputPath, options = {}) {
    const { onLog = null } = options;

    try {
      const downloadingLogMsg = {
        logKey: "log.lyrics.downloading",
        logVars: { artist, title },
        fallback: `📥 Şarkı sözleri indiriliyor: "${artist}" - "${title}"`,
      };
      emitLog(onLog, downloadingLogMsg);

      const lyricsData = await this.searchLyrics(artist, title, duration, { onLog });

      if (!lyricsData) {
        const nothingToDownloadLogMsg = {
          logKey: "log.lyrics.nothingToDownload",
          logVars: { title },
          fallback: `❌ İndirilecek söz bulunamadı: ${title}`,
        };
        emitLog(onLog, nothingToDownloadLogMsg);
        return null;
      }

      let lyricsContent = "";

      if (lyricsData.syncedLyrics) {
      lyricsContent = lyricsData.syncedLyrics;
      const usingSyncedLogMsg = {
        logKey: "log.lyrics.usingSynced",
        logVars: { title },
        fallback: `🎵 Zamanlı (synced) sözler kullanılıyor: ${title}`,
      };
      emitLog(onLog, usingSyncedLogMsg);
    } else if (lyricsData.plainLyrics) {
      lyricsContent = lyricsData.plainLyrics;
      const usingPlainLogMsg = {
        logKey: "log.lyrics.usingPlain",
        logVars: { title },
        fallback: `📝 Düz metin sözler (plain) kullanılıyor: ${title}`,
      };
      emitLog(onLog, usingPlainLogMsg);
    }

      if (!lyricsContent.trim()) {
        const emptyContentLogMsg = {
          logKey: "log.lyrics.emptyContent",
          logVars: { title },
          fallback: `❌ Söz içeriği boş: ${title}`,
        };
        emitLog(onLog, emptyContentLogMsg);
        return null;
      }

      const lrcPath = outputPath.replace(/\.[^/.]+$/, "") + ".lrc";
      const savingLogMsg = {
        logKey: "log.lyrics.saving",
        logVars: { path: lrcPath },
        fallback: `💾 Sözler kaydediliyor: ${lrcPath}`,
      };
      emitLog(onLog, savingLogMsg);

      fs.writeFileSync(lrcPath, lyricsContent, "utf8");

      const savedLogMsg = {
        logKey: "log.lyrics.saved",
        logVars: { path: lrcPath },
        fallback: `✅ Sözler kaydedildi: ${lrcPath}`,
      };
      emitLog(onLog, savedLogMsg);
      return lrcPath;
    } catch (error) {
      const downloadErrorLogMsg = {
        logKey: "log.lyrics.downloadError",
        logVars: { artist, title, err: error.message },
        fallback: `❌ Söz indirme hatası (${artist} - ${title}): ${error.message}`,
      };
      emitLog(onLog, downloadErrorLogMsg);
      return null;
    }
  }

  convertToLRC(plainLyrics) {
    const lines = plainLyrics.split("\n").filter((line) => line.trim());
    const lrcLines = lines.map((line) => `[00:00.00]${line.trim()}`);
    return lrcLines.join("\n");
  }

  formatLrcTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const cents = Math.floor((seconds % 1) * 100);
    return `[${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}.
${cents.toString().padStart(2, "0")}]`;
  }
}

export const lyricsFetcher = new LyricsFetcher();

export async function attachLyricsToMedia(filePath, metadata, options = {}) {
  const { includeLyrics = true, jobId = null, onLog = null, onLyricsStats = null } = options;

  if (!includeLyrics) {
    const disabledLogMsg = {
      logKey: "log.lyrics.disabled",
      logVars: { file: path.basename(filePath) },
      fallback: `⚙️ Söz ekleme özelliği devre dışı — ${path.basename(filePath)}`,
    };
    emitLog(onLog, disabledLogMsg);
    return null;
  }

  try {
    const artist = metadata.artist || metadata.uploader || "";
    const title = metadata.title || metadata.track || "";
    const duration = metadata.duration;

    const searchingForFileLogMsg = {
      logKey: "log.lyrics.searchingForFile",
      logVars: { artist, title, file: path.basename(filePath) },
      fallback: `🎵 Şarkı sözleri aranıyor: "${artist}" - "${title}" - ${path.basename(filePath)}`,
    };
    emitLog(onLog, searchingForFileLogMsg);

    if (!artist || !title) {
      const missingMetadataLogMsg = {
        logKey: "log.lyrics.missingMetadata",
        logVars: { artist, title },
        fallback: `❌ Sanatçı veya başlık eksik — Sanatçı: "${artist}", Başlık: "${title}"`,
      };
      emitLog(onLog, missingMetadataLogMsg);
      return null;
    }

    const lyricsPath = await lyricsFetcher.downloadLyrics(artist, title, duration, filePath, { onLog });

    if (onLyricsStats) {
      if (lyricsPath) {
        onLyricsStats({ found: 1, notFound: 0 });
      } else {
        onLyricsStats({ found: 0, notFound: 1 });
      }
    }

    if (lyricsPath) {
      const attachedLogMsg = {
        logKey: "log.lyrics.attached",
        logVars: { file: path.basename(lyricsPath) },
        fallback: `✅ Sözler başarıyla eklendi: ${path.basename(lyricsPath)}`,
      };
      emitLog(onLog, attachedLogMsg);
    } else {
      const notFoundForTrackLogMsg = {
        logKey: "log.lyrics.notFoundForTrack",
        logVars: { artist, title },
        fallback: `❌ Şarkı sözleri bulunamadı: "${artist}" - "${title}"`,
      };
      emitLog(onLog, notFoundForTrackLogMsg);
    }

    return lyricsPath;
  } catch (error) {
    const attachmentErrorLogMsg = {
      logKey: "log.lyrics.attachmentError",
      logVars: { err: error.message, file: path.basename(filePath) },
      fallback: `❌ Söz eklenirken hata oluştu: ${error.message} — ${path.basename(filePath)}`,
    };
    emitLog(onLog, attachmentErrorLogMsg);
    return null;
  }
}
