import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { sanitizeFilename } from "./utils.js";

export function resolveTemplate(meta, template) {
  const pick = (a,b)=> (meta[a]||"").toString().trim() || (meta[b]||"").toString().trim();
  return template.replace(/%\(([^)]+)\)s/g, (_, keyExpr) => {
    if (keyExpr.includes("|")) { const [a,b]=keyExpr.split("|").map(s=>s.trim()); return pick(a,b)||""; }
    const v = (meta[keyExpr] || "").toString().trim();
    return v || "";
  })
  .replace(/\s+-\s+/g, " - ")
  .replace(/^\s*-\s+/, "")
  .replace(/\s+-\s*$/, "")
  .replace(/\s{2,}/g, " ")
  .trim();
}

export function maybeCleanTitle(t){
  if (!t) return t;
  if (process.env.TITLE_CLEAN_PIPE === "1") { const parts=t.split("|").map(s=>s.trim()); if (parts.length>1) return parts.at(-1); }
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
    if (ct.includes("image/webp")) ext = ".webp"; else if (ct.includes("image/png")) ext = ".png"; else if (ct.includes("jpeg")) ext = ".jpg";
    const destPath = `${destBasePathNoExt}${ext}`;
    fs.writeFileSync(destPath, Buffer.from(buf));
    return destPath;
  } catch { return null; }
}

export async function ensureJpegCover(coverPath, jobId, tempDir) {
  try {
    if (!coverPath || !fs.existsSync(coverPath)) return null;
    const ext = path.extname(coverPath).toLowerCase();
    if ([".jpg",".jpeg"].includes(ext)) return coverPath;
    const outJpg = path.join(tempDir, `${jobId}.cover.norm.jpg`);
    await new Promise((resolve, reject) => {
      const args=["-y","-hide_banner","-loglevel","error","-i", coverPath, outJpg];
      const p = spawn("ffmpeg", args);
      let err="";
      p.stderr.on("data", d=> err += d.toString());
      p.on("close", code=> code===0 && fs.existsSync(outJpg) ? resolve() : reject(new Error(`Kapak dönüştürülemedi (code ${code}): ${err}`)));
      p.on("error", e=> reject(new Error(`ffmpeg spawn error: ${e.message}`)));
    });
    return outJpg;
  } catch (e) { console.warn("ensureJpegCover uyarı:", e.message); return null; }
}

export async function convertMedia(inputPath, format, bitrate, jobId, onProgress, meta, coverPath, isVideo, OUTPUT_DIR, TEMP_DIR){
  const template = isVideo
    ? (process.env.FILENAME_TEMPLATE_VIDEO || "%(title)s")
    : (process.env.FILENAME_TEMPLATE || "%(artist)s - %(track|title)s");
  const resolvedMeta = { ...meta, title: maybeCleanTitle(meta?.title) };
  const VIDEO_MAX_H = Number(resolvedMeta.__maxHeight) || 1080;

  let basename = resolveTemplate(resolvedMeta, template) || `output_${jobId}`;
  basename = sanitizeFilename(basename);

  let outputFileName = `${basename}.${format}`;
  let outputPath = path.join(OUTPUT_DIR, outputFileName);
  let idx = 1;
  while (fs.existsSync(outputPath)) { outputFileName = `${basename} (${idx++}).${format}`; outputPath = path.join(OUTPUT_DIR, outputFileName); }

  let canEmbedCover = false; let coverToUse = null;
  if (!isVideo && coverPath && ["mp3","flac"].includes(format)) {
    try { coverToUse = await ensureJpegCover(coverPath, jobId, TEMP_DIR); } catch {}
    if (coverToUse && fs.existsSync(coverToUse)) canEmbedCover = true;
  }

  return new Promise((resolve, reject) => {
    const args = ["-hide_banner","-nostdin","-y","-i", inputPath];
    if (!isVideo && !canEmbedCover) args.push("-vn");
    if (canEmbedCover) args.push("-i", coverToUse);

    const tn  = Number(resolvedMeta.track_number) || null;
    const ttot= Number(resolvedMeta.track_total)  || null;
    const dn  = Number(resolvedMeta.disc_number)  || null;
    const dtot= Number(resolvedMeta.disc_total)   || null;
    const trackTag = tn ? (ttot ? `${tn}/${ttot}` : String(tn)) : "";
    const discTag  = dn ? (dtot ? `${dn}/${dtot}` : String(dn)) : "";
    const dateTag = (resolvedMeta.release_date && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(resolvedMeta.release_date))
      ? resolvedMeta.release_date
      : (resolvedMeta.release_year || resolvedMeta.upload_date || "");

    const metaPairs = {
      title:   resolvedMeta.track || resolvedMeta.title || "",
      artist:  resolvedMeta.artist || "",
      album:   resolvedMeta.album || resolvedMeta.playlist_title || "",
      date:    dateTag || "",
      track:   trackTag || "",
      disc:    discTag || "",
      comment: resolvedMeta.webpage_url || resolvedMeta.spotifyUrl || "",
      genre:   resolvedMeta.genre || "",
    };
    for (const [k,v] of Object.entries(metaPairs)) if (v) args.push("-metadata", `${k}=${v}`);
    if (resolvedMeta.isrc) args.push("-metadata", `ISRC=${resolvedMeta.isrc}`);

    if (canEmbedCover) {
      args.push("-map","0:a","-map","1:v?","-disposition:v","attached_pic","-metadata:s:v","title=Album cover","-metadata:s:v","comment=Cover (front)");
      if (format === "mp3") args.push("-c:v","mjpeg","-id3v2_version","3");
      else if (format === "flac") args.push("-c:v","mjpeg");
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

    args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
    args.push(
      "-threads", "0",
      "-vf", `scale='if(gt(ih\\,${VIDEO_MAX_H}),-2,-1)':'if(gt(ih\\,${VIDEO_MAX_H}),${VIDEO_MAX_H},-1)'`
    );
  }
} else {
      switch(format){
        case "mp3":
          if (bitrate === "auto" || bitrate === "0") args.push("-acodec","libmp3lame","-q:a","0","-ar","44100");
          else args.push("-acodec","libmp3lame","-b:a", bitrate, "-ar","44100");
          break;
        case "flac": args.push("-acodec","flac","-compression_level","12"); break;
        case "wav":  args.push("-acodec","pcm_s16le","-ar","44100"); break;
        case "ogg":  (bitrate === "auto" || bitrate === "0") ? args.push("-acodec","libvorbis","-q:a","6") : args.push("-acodec","libvorbis","-b:a", bitrate); break;
      }
    }

    args.push(outputPath);

    const ffmpeg = spawn("ffmpeg", args);
    let duration=null; let stderrData="";

    ffmpeg.stderr.on("data", d => {
      const line = d.toString(); stderrData += line;
      if (!duration){ const m=line.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/); if (m){ const [_,h,mn,s]=m; duration= (+h)*3600 + (+mn)*60 + (+s); } }
      const t=line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (t && duration){ const [_,h,mn,s]=t; const cur=(+h)*3600 + (+mn)*60 + (+s); const p=Math.min(99, Math.floor((cur/duration)*100)); onProgress(p); }
    });

    ffmpeg.on("close", (code)=> code===0 ? (onProgress(100), resolve({ outputPath: `/download/${encodeURIComponent(outputFileName)}`, fileSize: fs.statSync(outputPath).size })) : reject(new Error(`FFmpeg error (code ${code}): ${stderrData.split("\n").slice(-10).join("\n")}`)));
    ffmpeg.on("error", e=> reject(new Error(`FFmpeg spawn error: ${e.message}`)));
  });
}
