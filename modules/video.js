import path from "path";
import fs from "fs";
import {
  downloadYouTubeVideo,
  buildEntriesMap,
  parsePlaylistIndexFromPath,
  isYouTubeAutomix
} from "./yt.js";
import { sanitizeFilename } from "./utils.js";

function safeRm(pathLike) {
  try {
    if (!pathLike || !fs.existsSync(pathLike)) return;
    const stat = fs.statSync(pathLike);
    if (stat.isDirectory()) {
      fs.rmSync(pathLike, { recursive: true, force: true });
    } else {
      fs.unlinkSync(pathLike);
    }
  } catch {}
}

function cleanupTempForJob(TEMP_DIR, jobId) {
  const playlistDir = path.join(TEMP_DIR, jobId);
  safeRm(playlistDir);
  safeRm(path.join(TEMP_DIR, `${jobId}.urls.txt`));
  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      if (f.startsWith(jobId)) {
        safeRm(path.join(TEMP_DIR, f));
      }
    }
  } catch {}
}

function safeMoveSync(src, dest) {
  try {
    fs.renameSync(src, dest);
    return;
  } catch (e) {
    if (!e || e.code !== "EXDEV") throw e;
    try {
      const flags = fs.constants?.COPYFILE_FICLONE || 0;
      fs.copyFileSync(src, dest, flags);
    } catch {
      fs.copyFileSync(src, dest);
    }
    try {
      const s1 = fs.statSync(src).size;
      const s2 = fs.statSync(dest).size;
      if (s1 !== s2) throw new Error("copy size mismatch");
    } catch (verifyErr) {
      try { fs.unlinkSync(dest); } catch {}
      throw verifyErr;
    }
    try { fs.unlinkSync(src); } catch {}
  }
}

function stripLeadingPrefix(basename, jobId) {
  const noJob = basename.replace(new RegExp(`^${jobId}\\s*-\\s*`), "");
  return noJob.replace(/^(\d+)\s*-\s*/, "");
}

function uniqueOutPath(dir, base, ext) {
  let name = `${base}${ext}`;
  let out = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(out)) {
    name = `${base} (${i++})${ext}`;
    out = path.join(dir, name);
  }
  return out;
}

function qualityToHeight(q) {
  const v = String(q || "").toLowerCase();
  if (v.includes("1080")) return 1080;
  if (v.includes("720")) return 720;
  if (v.includes("480")) return 480;
  if (v.includes("360")) return 360;
  return 1080;
}

/**
 * MP4 işler için convert atlanır; temp'e inen dosyalar başlık adıyla outputs'a taşınır.
 */
export async function processYouTubeVideoJob(job, {
  OUTPUT_DIR = path.resolve(process.cwd(), "outputs"),
  TEMP_DIR   = path.resolve(process.cwd(), "temp"),
}) {
  const TARGET_H = qualityToHeight(job.bitrate);
  const format = "mp4";

  job.currentPhase = "downloading";
  job.downloadProgress = 5;

  const isAutomix = job.metadata.isAutomix || isYouTubeAutomix(job.metadata.url);
  const flat = {
    title:        job.metadata?.extracted?.title || "",
    uploader:     job.metadata?.extracted?.uploader || "",
    album:        job.metadata?.extracted?.album || "",
    webpage_url:  job.metadata?.extracted?.webpage_url || job.metadata.url,
    playlist_title: job.metadata?.extracted?.playlist_title || "",
  };

  const isPl = !!job.metadata.isPlaylist || isAutomix;

  const onProgress = (p) => {
    job.downloadProgress = Math.max(job.downloadProgress, Math.min(100, Math.floor(p)));
    job.progress = Math.floor((job.downloadProgress + (job.convertProgress || 0)) / 2);
  };

  if (isPl) {
    const selected = job.metadata.selectedIndices;
    const indices = (selected === "all" || !selected) ? null : selected;
    const selectedIds = Array.isArray(job.metadata.selectedIds) ? job.metadata.selectedIds : null;

    const dlUrlPl = (job.metadata.url || "").replace("music.youtube.com", "www.youtube.com");
    const files = await downloadYouTubeVideo(
      dlUrlPl,
      job.id,
      true,
      indices,
      isAutomix,
      selectedIds,
      TEMP_DIR,
      onProgress,
      { video: true, maxHeight: TARGET_H }
    );

    job.downloadProgress = 100;
    job.currentPhase = "finalizing";
    job.convertProgress = 0;

    if (!Array.isArray(files) || !files.length) {
      throw new Error("Playlist/Automix dosyaları bulunamadı.");
    }

    if (!Array.isArray(job.metadata.frozenEntries) || job.metadata.frozenEntries.length === 0) {
      const fe = [];
      const byIndex = buildEntriesMap(job.metadata.extracted);
      const metaEntries = Array.isArray(job.metadata?.extracted?.entries) ? job.metadata.extracted.entries : [];

      for (let i = 0; i < files.length; i++) {
        const filePath = files[i];
        const idxFromName = parsePlaylistIndexFromPath(filePath);
        let src = null;

        if (Number.isFinite(idxFromName) && byIndex.has(idxFromName)) {
          src = byIndex.get(idxFromName);
        } else if (Array.isArray(selectedIds) && selectedIds[i]) {
          src = metaEntries.find(e => e?.id === selectedIds[i]) || null;
        }

        const title = (src?.title || src?.alt_title || path.basename(filePath, path.extname(filePath)).replace(/^\d+\s*-\s*/, "") || "").toString();
        const uploader = (src?.uploader || src?.channel || flat.uploader || "").toString();
        const id = (src?.id || (Array.isArray(selectedIds) ? selectedIds[i] : null) || "").toString();
        const webpage_url = (src?.webpage_url || src?.url || flat.webpage_url || "").toString();
        const index = Number.isFinite(idxFromName) ? idxFromName : (i + 1);

        fe.push({ index, id, title, uploader, webpage_url });
      }

      job.metadata.frozenEntries = fe;
      job.metadata.frozenTitle = job.metadata.frozenTitle || flat.title || flat.playlist_title || (isAutomix ? "YouTube Automix" : "");
    }

    const sorted = files.map((fp, i) => ({ fp, auto: i + 1 })).sort((a, b) => a.auto - b.auto);
    const results = [];
    job.playlist = { total: sorted.length, done: 0 };

    for (let i = 0; i < sorted.length; i++) {
      const { fp: filePath } = sorted[i];

      const ext = path.extname(filePath);
      const rawBase = path.basename(filePath);
      const cleaned = stripLeadingPrefix(rawBase, job.id).replace(ext, "").trim();
      const cleanTitle = sanitizeFilename(cleaned) || "video";

      const targetAbs = uniqueOutPath(OUTPUT_DIR, cleanTitle, ext);
      safeMoveSync(filePath, targetAbs);

      results.push({
        outputPath: `/download/${encodeURIComponent(path.basename(targetAbs))}`,
        fileSize: fs.statSync(targetAbs).size
      });

      job.playlist.done = i + 1;
      const fileProgress = (i / sorted.length) * 100;
      job.convertProgress = Math.floor(fileProgress + (100 / sorted.length));
      job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
    }

    job.resultPath = results;
    job.status = "completed";
    job.progress = 100;
    job.downloadProgress = 100;
    job.convertProgress = 100;
    job.currentPhase = "completed";
    cleanupTempForJob(TEMP_DIR, job.id);
    return;
  }

  const dlUrlSingle = (job.metadata.url || "").replace("music.youtube.com", "www.youtube.com");
  const filePath = await downloadYouTubeVideo(
    dlUrlSingle,
    job.id,
    false,
    null,
    false,
    null,
    TEMP_DIR,
    onProgress,
    { video: true, maxHeight: TARGET_H }
  );

  job.downloadProgress = 100;
  job.currentPhase = "finalizing";

  const ext = path.extname(filePath);
  const rawBase = path.basename(filePath);
  const cleaned = stripLeadingPrefix(rawBase, job.id).replace(ext, "").trim();
  const cleanTitle = sanitizeFilename(cleaned) || "video";

  const targetAbs = uniqueOutPath(OUTPUT_DIR, cleanTitle, ext);
  safeMoveSync(filePath, targetAbs);

  job.resultPath = `/download/${encodeURIComponent(path.basename(targetAbs))}`;
  job.status = "completed";
  job.progress = 100;
  job.downloadProgress = 100;
  job.convertProgress = 100;
  job.currentPhase = "completed";
  cleanupTempForJob(TEMP_DIR, job.id);
}
