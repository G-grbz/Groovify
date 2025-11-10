import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import fetch from "node-fetch";
import { sanitizeFilename, findOnPATH, isExecutable } from "./utils.js";
import { attachLyricsToMedia } from "./lyrics.js";
import { jobs } from "./store.js";
import 'dotenv/config';

function resolveFfmpegBin() {
  const isWin = process.platform === "win32";
  const exe = isWin ? "ffmpeg.exe" : "ffmpeg";
  const fromPATH = findOnPATH(exe);
  if (fromPATH && isExecutable(fromPATH)) return fromPATH;
  const guesses = isWin
     ? [
         "C:\\tools\\ffmpeg\\bin\\ffmpeg.exe",
         "C:\\ffmpeg\\bin\\ffmpeg.exe",
         "C:\\tools\\yt-dlp\\ffmpeg.exe",
         "C:\\Windows\\ffmpeg.exe"
       ]
     : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/bin/ffmpeg"];
  if (process.resourcesPath) {
     const packed = path.join(process.resourcesPath, "bin", exe);
     guesses.unshift(packed);
   }

   for (const g of guesses) {
     if (isExecutable(g)) return g;
   }

  const fromEnvFile = process.env.FFMPEG_BIN || process.env.FFMPEG_PATH;
  if (fromEnvFile && isExecutable(fromEnvFile)) return fromEnvFile;
  const fromEnvDir = process.env.FFMPEG_DIR;
  if (fromEnvDir) {
    const candidate = path.join(fromEnvDir, exe);
    if (isExecutable(candidate)) return candidate;
  }

   return exe;
}

function emitLog(onLog, payload) {
  if (payload?.fallback) console.log(payload.fallback);
  if (onLog) onLog(payload);
}

export function resolveTemplate(meta, template) {
  const pick = (a, b) => (meta[a] || "").toString().trim() || (meta[b] || "").toString().trim();
  return template
    .replace(/%\(([^)]+)\)s/g, (_, keyExpr) => {
      if (keyExpr.includes("|")) {
        const [a, b] = keyExpr.split("|").map((s) => s.trim());
        return pick(a, b) || "";
      }
      const v = (meta[keyExpr] || "").toString().trim();
      return v || "";
    })
    .replace(/\s+-\s+/g, " - ")
    .replace(/^\s*-\s+/, "")
    .replace(/\s+-\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function maybeCleanTitle(t) {
  if (!t) return t;
  if (process.env.TITLE_CLEAN_PIPE === "1") {
    const parts = t.split("|").map((s) => s.trim());
    if (parts.length > 1) return parts.at(-1);
  }
  return t;
}

export async function downloadThumbnail(thumbnailUrl, destBasePathNoExt) {
  if (!thumbnailUrl) return null;
  try {
    const res = await fetch(thumbnailUrl);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    let ext = ".jpg";
    if (ct.includes("image/webp")) ext = ".webp";
    else if (ct.includes("image/png")) ext = ".png";
    else if (ct.includes("jpeg")) ext = ".jpg";
    const destPath = `${destBasePathNoExt}${ext}`;
    fs.writeFileSync(destPath, Buffer.from(buf));
    return destPath;
  } catch {
    return null;
  }
}

export async function ensureJpegCover(coverPath, jobId, tempDir, ffmpegFromCaller = null) {
  try {
    if (!coverPath || !fs.existsSync(coverPath)) return null;
    const ext = path.extname(coverPath).toLowerCase();
    if ([".jpg", ".jpeg"].includes(ext)) return coverPath;

    const ffmpegBin = ffmpegFromCaller || resolveFfmpegBin();
    const outJpg = path.join(tempDir, `${jobId}.cover.norm.jpg`);
    await new Promise((resolve, reject) => {
      const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", coverPath, outJpg];
      const p = spawn(ffmpegBin, args);
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) =>
        code === 0 && fs.existsSync(outJpg)
          ? resolve()
          : reject(new Error(`Kapak dönüştürülemedi (kod ${code}): ${err}`))
      );
      p.on("error", (e) => reject(new Error(`ffmpeg başlatma hatası: ${e.message}`)));
    });
    return outJpg;
  } catch (e) {
    console.warn("⚠️ Kapak dönüştürme uyarısı:", e.message);
    return null;
  }
}

const getCommentText = () => {
  if (process.env.MEDIA_COMMENT) return process.env.MEDIA_COMMENT;
  if (process.env.COMMENT_TEXT) return process.env.COMMENT_TEXT;
  return "Gharmonize";
};

export async function convertMedia(
  inputPath,
  format,
  bitrate,
  jobId,
  progressCallback,
  metadata = {},
  coverPath = null,
  isVideo = false,
  outputDir,
  tempDir,
  opts = {}
) {
  const ffmpegFromOpts = opts?.ffmpegBin || null;
  const isCanceled =
    typeof opts.isCanceled === "function" ? () => !!opts.isCanceled() : () => false;

    const stereoConvert = opts?.stereoConvert || "auto";
    const atempoAdjust = opts?.atempoAdjust || "none";

    const parseSR = (v) => {
    const n = Number(String(v || "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? Math.round(n) : NaN;
  };

  const isEac3Ac3 = format === "eac3" || format === "ac3";
  const srOpt1 = parseSR(opts?.sampleRate);
  const srOpt2 = parseSR(opts?.sampleRateHz);
  const srEnv = parseSR(process.env.TARGET_SAMPLE_RATE);
  let SAMPLE_RATE;
   if (isEac3Ac3) {
       SAMPLE_RATE = Number.isFinite(srOpt1) ? srOpt1
           : Number.isFinite(srOpt2) ? srOpt2
           : Number.isFinite(srEnv) ? srEnv
           : 48000;
   } else {
       SAMPLE_RATE = Number.isFinite(srOpt1) ? srOpt1
           : Number.isFinite(srOpt2) ? srOpt2
           : Number.isFinite(srEnv) ? srEnv
           : 48000;
   }

  const SAFE_SR = Math.min(192000, Math.max(8000, SAMPLE_RATE));

  const pickNearest = (target, allowed) =>
    allowed.reduce((best, cur) => (Math.abs(cur - target) < Math.abs(best - target) ? cur : best), allowed[0]);

  function commentKeyFor(fmt) {
    const f = String(fmt || "").toLowerCase();
    if (f === "flac" || f === "ogg") return "DESCRIPTION";
    if (f === "mp4" || f === "m4a") return "comment";
    if (f === "mp3") return "comment";
    if (f === "eac3" || f === "ac3") return "comment";
    return "comment";
  }
  const COMMENT_KEY = commentKeyFor(format);

  function normalizeSR(fmt, sr) {
    const f = String(fmt || "").toLowerCase();
    if (f === "mp3") {
      const allowed = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
      const picked = pickNearest(sr, allowed);
      return { sr: picked, note: "mp3-legal" };
    }
    if (f === "mp4") {
      const picked = Math.min(48000, Math.max(8000, sr));
      return { sr: picked, note: "aac-clamped" };
    }
    return { sr: sr, note: "as-is" };
  }
  const { sr: SR_NORM, note: SR_NOTE } = normalizeSR(format, SAFE_SR);

  const srSrc =
    Number.isFinite(srOpt1) ? "opt.sampleRate"
    : Number.isFinite(srOpt2) ? "opt.sampleRateHz"
    : Number.isFinite(srEnv) ? "env"
    : "default";

  console.log(
    `🎵 Dönüştürme → in: ${path.basename(inputPath)} | fmt=${format} | lyrics=${
      opts.includeLyrics !== false ? "evet" : "hayır"
    } | video=${isVideo ? "evet" : "hayır"} | sr=${SAMPLE_RATE}Hz (src=${srSrc}→${SR_NORM} ${SR_NOTE}) | stereo=${stereoConvert} | atempo=${atempoAdjust}`
  );

  const template = isVideo
    ? process.env.FILENAME_TEMPLATE_VIDEO || "%(title)s"
    : process.env.FILENAME_TEMPLATE || "%(artist)s - %(track|title)s";

  const resolvedMeta = { ...metadata, title: maybeCleanTitle(metadata?.title) };
  const VIDEO_MAX_H = Number(resolvedMeta.__maxHeight) || 1080;

  let basename = resolveTemplate(resolvedMeta, template) || `output_${jobId}`;
  basename = sanitizeFilename(basename);

  let outputFileName = `${basename}.${format}`;
  let outputPath = path.join(outputDir, outputFileName);
  let idx = 1;
  while (fs.existsSync(outputPath)) {
    outputFileName = `${basename} (${idx++}).${format}`;
    outputPath = path.join(outputDir, outputFileName);
  }

  let canEmbedCover = false;
  let coverToUse = null;

  if (!isVideo && coverPath && ["mp3", "flac"].includes(format)) {
    try {
      coverToUse = await ensureJpegCover(coverPath, jobId, tempDir, ffmpegFromOpts);
    } catch (e) {
      console.warn("⚠️ Kapak dönüştürme hatası:", e.message);
    }
    if (coverToUse && fs.existsSync(coverToUse)) canEmbedCover = true;
  }

  const ffmpegBin = ffmpegFromOpts || resolveFfmpegBin();
  console.log(`🧭 Kullanılan FFmpeg: ${ffmpegBin}`);

  const result = await new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostdin", "-y", "-i", inputPath];

    if (isCanceled()) return reject(new Error("CANCELED"));

    if (!isVideo && !canEmbedCover) args.push("-vn");
    if (canEmbedCover) args.push("-i", coverToUse);

    const tn = Number(resolvedMeta.track_number) || null;
    const ttot = Number(resolvedMeta.track_total) || null;
    const dn = Number(resolvedMeta.disc_number) || null;
    const dtot = Number(resolvedMeta.disc_total) || null;
    const trackTag = tn ? (ttot ? `${tn}/${ttot}` : String(tn)) : "";
    const discTag = dn ? (dtot ? `${dn}/${dtot}` : String(dn)) : "";
    const dateTag =
      resolvedMeta.release_date && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(resolvedMeta.release_date)
        ? resolvedMeta.release_date
        : resolvedMeta.release_year || resolvedMeta.upload_date || "";

    const metaPairs = {
      title: resolvedMeta.track || resolvedMeta.title || "",
      artist: resolvedMeta.artist || "",
      album: resolvedMeta.album || resolvedMeta.playlist_title || "",
      date: dateTag || "",
      track: trackTag || "",
      disc: discTag || "",
      genre: resolvedMeta.genre || ""
    };

    if (resolvedMeta.album_artist) metaPairs.album_artist = resolvedMeta.album_artist;

    const labelLike = resolvedMeta.label || resolvedMeta.publisher;
    if (labelLike) metaPairs.publisher = labelLike;

    if (resolvedMeta.copyright) metaPairs.copyright = resolvedMeta.copyright;

    args.push("-map_metadata", "-1");

    for (const [k, v] of Object.entries(metaPairs)) {
      if (v) args.push("-metadata", `${k}=${v}`);
    }

    const commentText = getCommentText();
    if (commentText && format !== "mp3") {
      args.push("-metadata", `${COMMENT_KEY}=${commentText}`);
    }

    if (resolvedMeta.isrc) args.push("-metadata", `ISRC=${resolvedMeta.isrc}`);

    if (!isVideo && (format === "flac" || format === "ogg")) {
      if (resolvedMeta.album_artist) args.push("-metadata", `ALBUMARTIST=${resolvedMeta.album_artist}`);
      if (labelLike) {
        args.push("-metadata", `LABEL=${labelLike}`);
        args.push("-metadata", `PUBLISHER=${labelLike}`);
      }
      if (resolvedMeta.webpage_url) args.push("-metadata", `URL=${resolvedMeta.webpage_url}`);
      if (resolvedMeta.genre) args.push("-metadata", `GENRE=${resolvedMeta.genre}`);
      if (resolvedMeta.copyright) args.push("-metadata", `COPYRIGHT=${resolvedMeta.copyright}`);
    }

    if (!isVideo && format === "mp3") {
      if (resolvedMeta.album_artist) args.push("-metadata", `ALBUMARTIST=${resolvedMeta.album_artist}`);
      if (resolvedMeta.genre) args.push("-metadata", `genre=${resolvedMeta.genre}`);
      if (resolvedMeta.copyright) args.push("-metadata", `copyright=${resolvedMeta.copyright}`);
      if (resolvedMeta.webpage_url) args.push("-metadata", `URL=${resolvedMeta.webpage_url}`);

      const cmt = getCommentText();
      if (cmt) args.push("-metadata", `comment=${cmt}`);
    }

    if (canEmbedCover) {
      args.push(
        "-map", "0:a",
        "-map", "1:v?",
        "-disposition:v", "attached_pic",
        "-metadata:s:v", "title=Album cover"
      );
      if (format === "mp3") args.push("-c:v", "mjpeg", "-id3v2_version", "3");
      else if (format === "flac") args.push("-c:v", "mjpeg");
    }

    if (isVideo) {
      if (format === "mp4") {
        const br = (bitrate || "").toString().trim();
        const isVidMb = /^[0-9]+(\.[0-9]+)?m$/i.test(br);
        const isVidKb = /^[0-9]+k$/i.test(br);
        args.push("-c:v", "libx264", "-preset", "medium", "-tune", "film");

        if (isVidMb || isVidKb) {
          const bv = isVidMb ? br.replace(/m$/i, "M") : br;
          args.push("-b:v", bv, "-maxrate", bv, "-bufsize", `${bv}*2`);
        } else {
          const crf = br === "auto" || br === "0" ? "23" : "21";
          args.push("-crf", crf);
        }

        args.push(
          "-pix_fmt", "yuv420p",
          "-profile:v", "high",
          "-level", "4.1",
          "-movflags", "+faststart",
          "-g", "60",
          "-keyint_min", "60",
          "-sc_threshold", "0"
        );

        args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", String(SR_NORM));
        args.push("-threads", "0", "-vf", `scale='if(gt(ih\\,${VIDEO_MAX_H}),-2,-1)':'if(gt(ih\\,${VIDEO_MAX_H}),${VIDEO_MAX_H},-1)'`);
      }
    } else {
      switch (format) {
        case "mp3":
          args.push("-id3v2_version", "3");
          if (process.env.WRITE_ID3V1 === "1") args.push("-write_id3v1", "1");
          if (bitrate === "auto" || bitrate === "0") {
            args.push("-acodec", "libmp3lame", "-q:a", "0", "-ar", String(SR_NORM));
          } else {
            args.push("-acodec", "libmp3lame", "-b:a", bitrate, "-ar", String(SR_NORM));
          }
          break;
        case "flac":
          args.push("-acodec", "flac", "-compression_level", "12", "-ar", String(SR_NORM));
          break;
        case "wav":
          args.push("-acodec", "pcm_s16le", "-ar", String(SR_NORM));
          break;
        case "ogg":
          if (bitrate === "auto" || bitrate === "0") {
            args.push("-acodec", "libvorbis", "-q:a", "6", "-ar", String(SR_NORM));
          } else {
            args.push("-acodec", "libvorbis", "-b:a", bitrate, "-ar", String(SR_NORM));
          }
          break;
          case "eac3":
          case "ac3":
          args.push("-acodec", format, "-b:a", bitrate, "-ar", String(SR_NORM));
          if (stereoConvert === "force") args.push("-ac", "2");
          break;
      }
    }

    if (!isVideo && atempoAdjust !== "none") {
      const ratioTable = {
        "24000_23976": 24000 / 23976,
        "25_24": 24 / 25,
        "25_23976": 23976 / 25000,
        "30_23976": 23976 / 30000,
        "30_24": 24 / 30,
        "24000_25000": 25000 / 24000,
        "23976_24000": 24000 / 23976,
        "23976_25000": 25000 / 23976,
        "30000_23976": 23976 / 30000,
        "30000_25000": 25000 / 30000
      };

      const target = ratioTable[atempoAdjust];
      if (Number.isFinite(target) && target > 0) {
        const splitAtempo = (f) => {
          const parts = [];
          let x = f;
          while (x < 0.5) {
            parts.push(0.5);
            x = x / 0.5;
          }
          while (x > 2.0) {
            parts.push(2.0);
            x = x / 2.0;
          }
          parts.push(x);
          return parts.map(v => +v.toFixed(6));
        };

        const chain = splitAtempo(target);
        if (chain.length) {
          const expr = chain.map(v => `atempo=${v}`).join(",");
          args.push("-af", expr);
        }
      }
    }

    args.push(outputPath);

    console.log("🔧 FFmpeg argümanları:", args.join(" "));

    let triedFallback = false;
    let ffmpeg = spawn(ffmpegBin, args);
    try {
      if (typeof opts.onProcess === "function") {
        opts.onProcess(ffmpeg);
      }
    } catch {}
    let duration = null;
    let stderrData = "";
    let canceledByFlag = false;

    const tryCancel = () => {
      if (!canceledByFlag && isCanceled()) {
        canceledByFlag = true;
        try {
          ffmpeg.kill("SIGTERM");
        } catch {}
      }
    };

    ffmpeg.stderr.on("data", (d) => {
      const line = d.toString();
      stderrData += line;

      if (!duration) {
        const m = line.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
          const [, h, mn, s] = m;
          duration = +h * 3600 + +mn * 60 + +s;
        }
      }

      tryCancel();

      const t = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (t && duration) {
        const [, h, mn, s] = t;
        const cur = +h * 3600 + +mn * 60 + +s;
        const p = Math.min(99, Math.floor((cur / duration) * 100));
        progressCallback(p);
        tryCancel();
      }
    });

    ffmpeg.on("close", (code) => {
      const actualOut = outputPath;
      if (canceledByFlag || isCanceled()) {
        try {
          if (actualOut && fs.existsSync(actualOut)) fs.unlinkSync(actualOut);
        } catch {}
        return reject(new Error("CANCELED"));
      }

      if (code === 0 && fs.existsSync(outputPath)) {
        progressCallback(100);
        console.log(`✅ Dönüştürme tamamlandı: ${outputPath}`);
        resolve({
          outputPath: `/download/${encodeURIComponent(outputFileName)}`,
          fileSize: fs.statSync(outputPath).size
        });
      } else {
        try {
          if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch {}
        const tail = stderrData.split("\n").slice(-10).join("\n");
        console.error(`❌ FFmpeg hatası (kod ${code}):\n${tail}`);
        reject(new Error(`FFmpeg hata (kod ${code}): ${tail}`));
      }
    });

    ffmpeg.on("error", (e) => {
      console.error(`❌ FFmpeg başlatma hatası: ${e.message}`);
      if (!triedFallback && /ENOENT/i.test(e.message)) {
        triedFallback = true;
        try {
          ffmpeg = spawn(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg", args);
          if (typeof opts.onProcess === "function") {
            try { opts.onProcess(ffmpeg); } catch {}
          }
          ffmpeg.stderr.on("data", (d) => {  });
          ffmpeg.on("close", (code) => { });
          ffmpeg.on("error", (e2) => {
            reject(new Error(`FFmpeg spawn error (fallback): ${e2.message}`));
          });
          return;
        } catch (e2) {
          return reject(new Error(`FFmpeg spawn error (fallback init): ${e2.message}`));
        }
      }
      reject(new Error(`FFmpeg spawn error: ${e.message}`));
    });
  });

  try {
    if (isCanceled()) {
      return result;
    }
    const includeLyricsFlag = opts.includeLyrics !== false;

    console.log(
      `🔍 Söz kontrolü → eklenecek mi: ${includeLyricsFlag ? "evet" : "hayır"} | video: ${
        isVideo ? "evet" : "hayır"
      } | biçim: ${format} | meta: ${[metadata.artist, metadata.title || metadata.track].filter(Boolean).join(" - ")}`
    );

    if (includeLyricsFlag && !isVideo && result && result.outputPath) {
      console.log("🎵 Sözler ekleniyor...");
      const actualOutputPath = path.join(
        outputDir,
        decodeURIComponent(result.outputPath.replace("/download/", ""))
      );

      if (isCanceled()) {
        return result;
      }

      const lyricsLogCallback = (message) => {
        const line =
          typeof message === "object" && message?.fallback
            ? message.fallback
            : typeof message === "string"
            ? message
            : JSON.stringify(message);
        console.log(`[Söz ${jobId}] ${line}`);

        const job = jobs.get(jobId.split("_")[0]);
        if (job) {
          if (typeof message === "object" && message.logKey) {
            job.lastLogKey = message.logKey;
            job.lastLogVars = message.logVars || {};
            job.lastLog = message.fallback || "";
          } else {
            job.lastLog = line;
            job.lastLogKey = null;
            job.lastLogVars = null;
          }
        }
      };

      try {
        const lyricsPath = await attachLyricsToMedia(actualOutputPath, metadata, {
          includeLyrics: includeLyricsFlag,
          jobId: jobId.split("_")[0],
          onLog: lyricsLogCallback,
          onLyricsStats: opts.onLyricsStats
        });

        if (lyricsPath) {
          console.log(`✅ Sözler başarıyla eklendi: ${lyricsPath}`);
          result.lyricsPath = `/download/${encodeURIComponent(path.basename(lyricsPath))}`;

          const job = jobs.get(jobId.split("_")[0]);
          if (job) {
            job.lastLog = `🎼 Söz dosyası eklendi: ${path.basename(lyricsPath)}`;
            if (!job.metadata.lyricsStats) {
              job.metadata.lyricsStats = { found: 0, notFound: 0 };
            }
            job.metadata.lyricsStats.found++;
          }
        } else {
          console.log("ℹ️ Söz bulunamadı veya eklenemedi");
          const job = jobs.get(jobId.split("_")[0]);
          if (job) {
            job.lastLog = `🎼 Söz bulunamadı: ${metadata.title || "Bilinmiyor"}`;
            if (!job.metadata.lyricsStats) {
              job.metadata.lyricsStats = { found: 0, notFound: 0 };
            }
            job.metadata.lyricsStats.notFound++;
          }
        }
      } catch (lyricsError) {
        console.warn("❌ Söz ekleme hatası (ana işlem devam ediyor):", lyricsError);
        const job = jobs.get(jobId.split("_")[0]);
        if (job) {
          job.lastLog = `❌ Söz hatası: ${lyricsError.message}`;
        }
      }
    } else {
      console.log(
        `⚙️ Söz eklenmedi → eklensin mi: ${includeLyricsFlag ? "evet" : "hayır"} | sebep: ${
          isVideo ? "Video biçimi" : "Devre dışı"
        }`
      );
    }

    return result;
  } catch (error) {
    console.error("❌ Söz işleme hatası:", error);
    return result;
  }
}
