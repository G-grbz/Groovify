import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { runYtJson, resolveYtDlp, withYT403Workarounds } from "./yt.js";
import { registerJobProcess } from "./store.js";
import crypto from "crypto";

export function makeMapId(){ return crypto.randomBytes(8).toString("hex"); }

export async function searchYtmBestId(artist, title){
  const q = `${artist} ${title}`.trim();
  const data = await runYtJson([`ytsearch5:${q}`], "ytm-search", 40000);
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  if (!entries.length) return null;
  const aLow = (artist||"").toLowerCase();
  for (const e of entries){ const vid=e?.id; const et=(e?.title||"").toLowerCase(); const ch=(e?.uploader || e?.channel || "").toLowerCase(); if (vid && (et.includes(aLow) || ch.includes(aLow))) return vid; }
  return entries[0]?.id || null;
}

export function idsToMusicUrls(ids, useMusic = process.env.YT_USE_MUSIC !== "0"){
  return ids.map(id => useMusic ? `https://music.youtube.com/watch?v=${id}` : `https://www.youtube.com/watch?v=${id}`);
}

function getYtDlpCommonArgs(){
  const ua = process.env.YTDLP_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
  const base = ['--no-progress','--no-warnings','--force-ipv4','--retries','10','--fragment-retries','10','--retry-sleep','3','--user-agent', ua,'--add-header','Referer: https://www.youtube.com/','--add-header','Accept-Language: en-US,en;q=0.9','--extractor-args','youtube:player_client=android,web','--geo-bypass'];
  if (process.env.YTDLP_EXTRA) base.push(...process.env.YTDLP_EXTRA.split(/\s+/).filter(Boolean));
  return base;
}

export async function mapSpotifyToYtm(sp, onUpdate, { concurrency=3, onLog=null, shouldCancel=null }={}){
  let i=0, running=0; const results=new Array(sp.items.length);
  return new Promise((resolve)=>{
    const kick = ()=>{
      if (shouldCancel && shouldCancel()) { return resolve(results); }
      while (running < concurrency && i < sp.items.length){
        const idx = i++; running++;
        (async ()=>{
          const it = sp.items[idx];
          if (shouldCancel && shouldCancel()) { results[idx] = null; return; }
          if (onLog) onLog({ logKey: 'log.searchingTrack', logVars: { artist: it.artist, title: it.title }, fallback: `🔍 Aranıyor: ${it.artist} - ${it.title}` });
          let vid=null; try{ vid = await searchYtmBestId(it.artist, it.title); if (onLog && vid) onLog({ logKey: 'log.foundTrack', logVars: { artist: it.artist, title: it.title }, fallback: `✅ Bulundu: ${it.artist} - ${it.title}` });
            else if (onLog) onLog({ logKey: 'log.notFoundTrack', logVars: { artist: it.artist, title: it.title }, fallback: `❌ Bulunamadı: ${it.artist} - ${it.title}` });
          } catch(e){
            if (onLog) onLog({ logKey: 'log.searchError', logVars: { artist: it.artist, title: it.title, err: e.message }, fallback: `❌ Arama hatası: ${it.artist} - ${it.title} (${e.message})` });
          }
          const item={ index: idx+1, id: vid||null, title: it.title, uploader: it.artist, duration:null, duration_string:null, webpage_url: vid ? (process.env.YT_USE_MUSIC !== "0" ? `https://music.youtube.com/watch?v=${vid}` : `https://www.youtube.com/watch?v=${vid}`) : "", thumbnail:null };
          results[idx]=item; onUpdate(idx, item);
        })().finally(()=>{
          running--;
          if (shouldCancel && shouldCancel()) return resolve(results);
          if (i >= sp.items.length && running===0) resolve(results); else kick();
        });
      }
    };
    kick();
  });
}

export async function downloadMatchedSpotifyTracks(matchedItems, jobId, onProgress, onLog = null) {
  const TEMP_DIR = path.resolve(process.cwd(), "temp");
  const downloadDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(downloadDir, { recursive: true });

  const results = [];
  let completed = 0;
  const total = matchedItems.length;
  const concurrency = 4;
  let currentIndex = 0;
  let running = 0;

  if (onLog) onLog({ logKey: 'log.downloading.batchStart', logVars: { total, concurrency }, fallback: `🚀 ${total} parça paralel indirilmeye başlanıyor (max ${concurrency} eşzamanlı)...` });

  return new Promise((resolve, reject) => {
    const processNext = async () => {
      while (running < concurrency && currentIndex < total) {
        const index = currentIndex++;
        const item = matchedItems[index];
        running++;

        if (onLog) onLog({ logKey: 'log.downloading.start', logVars: { cur: index+1, total, artist: item.uploader, title: item.title }, fallback: `📥 İndiriliyor (${index + 1}/${total}): ${item.uploader} - ${item.title}` });

        try {
          const filePath = await downloadSingleYouTubeVideo(
            item.webpage_url,
            `${jobId}_${index}`,
            downloadDir
          );

          results.push({
            index: item.index,
            title: item.title,
            uploader: item.uploader,
            filePath,
            item
          });

          completed++;
          if (onProgress) onProgress(completed, total);
          if (onLog) onLog({ logKey: 'log.downloading.ok', logVars: { cur: index+1, total, artist: item.uploader, title: item.title }, fallback: `✅ İndirildi (${index + 1}/${total}): ${item.uploader} - ${item.title}` });

        } catch (error) {
          if (onLog) onLog({ logKey: 'log.downloading.err', logVars: { cur: index+1, total, artist: item.uploader, title: item.title, err: error.message }, fallback: `❌ İndirme hatası (${index + 1}/${total}): ${item.uploader} - ${item.title} - ${error.message}` });
          results.push({
            index: item.index,
            title: item.title,
            uploader: item.uploader,
            filePath: null,
            item,
            error: error.message
          });
          completed++;
          if (onProgress) onProgress(completed, total);
        } finally {
          running--;
          processNext();
        }
      }

      if (completed === total && running === 0) {
        const successful = results.filter(r => r.filePath).length;
        if (onLog) onLog({ logKey: 'log.downloading.summary', logVars: { ok: successful, total }, fallback: `📊 İndirme tamamlandı: ${successful}/${total} parça başarıyla indirildi` });
        resolve(results.sort((a, b) => a.index - b.index));
      }
    };

    processNext();
  });
}

export async function downloadSingleYouTubeVideo(url, fileId, downloadDir) {
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) throw new Error("yt-dlp bulunamadı");

  const template = path.join(downloadDir, `${fileId}.%(ext)s`);

  try {
    const pre = fs.readdirSync(downloadDir)
      .filter(f => f.startsWith(`${fileId}.`) && /(\.(mp4|webm|m4a|mp3|opus|flac|wav|aac|ogg))$/i.test(f));
    if (pre.length > 0) return path.join(downloadDir, pre[0]);
  } catch {}

  const base = [
    "-f","bestaudio/best","--no-playlist","--no-part","--continue","--no-overwrites",
    "--retries","3","--fragment-retries","3","--concurrent-fragments","1",
    "--write-thumbnail","--convert-thumbnails","jpg",
    "-o", template
  ];

  let args = [...getYtDlpCommonArgs(), ...base, url];
  const stripCookies = (process.env.YT_STRIP_COOKIES === "1");
  let finalArgs = withYT403Workarounds(args, { stripCookies });

  return new Promise((resolve, reject) => {
    const child = execFile(YTDLP_BIN, finalArgs, { maxBuffer: 1024 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) {
        try {
          const files = fs.readdirSync(downloadDir)
            .filter(f => f.startsWith(`${fileId}.`) && /(\.(mp4|webm|m4a|mp3|opus|flac|wav|aac|ogg))$/i.test(f));
          if (files.length > 0) return resolve(path.join(downloadDir, files[0]));
        } catch {}
        return reject(new Error("Dosya indirildi ama bulunamadı"));
      }

      const stderrStr = String(stderr || "");
      const is403 = /403|Forbidden/i.test(stderrStr);
      const isMusic = /music\.youtube\.com/i.test(url);
      if (is403 && isMusic) {
        const fallbackUrl = url.replace(/music\.youtube\.com/i, "www.youtube.com");
        const retryArgs = finalArgs
          .map(x => x)
          .filter(x => x !== url)
          .concat(fallbackUrl);
        const idxExtr = retryArgs.findIndex((v, i) => v === '--extractor-args');
        if (idxExtr >= 0 && retryArgs[idxExtr+1]) {
          retryArgs[idxExtr+1] = 'youtube:player_client=android,web';
        }
        const child2 = execFile(YTDLP_BIN, retryArgs, { maxBuffer: 1024 * 1024 * 1024 }, (err2, _so2, se2) => {
          if (!err2) {
            try {
              const files = fs.readdirSync(downloadDir)
                .filter(f => f.startsWith(`${fileId}.`) && /(\.(mp4|webm|m4a|mp3|opus|flac|wav|aac|ogg))$/i.test(f));
              if (files.length > 0) return resolve(path.join(downloadDir, files[0]));
            } catch {}
            return reject(new Error("Dosya indirildi ama bulunamadı"));
          }
          const tail2 = String(se2 || "").split("\n").slice(-10).join("\n");
          return reject(new Error(`yt-dlp hatası (fallback denemesi): ${err2.code}\n${tail2}`));
        });
        try { registerJobProcess(String(fileId).split("_")[0], child2); } catch {}
      }

      const tail = stderrStr.split("\n").slice(-10).join("\n");
      return reject(new Error(`yt-dlp hatası: ${err.code}\n${tail}`));
    });
    try { registerJobProcess(String(fileId).split("_")[0], child); } catch {}
  });
}

export function createDownloadQueue(jobId, { concurrency = 4, onProgress, onLog, shouldCancel } = {}) {
  const TEMP_DIR = path.resolve(process.cwd(), "temp");
  const downloadDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(downloadDir, { recursive: true });

  let running = 0;
  const q = [];
  const results = [];
  let total = 0, done = 0;
  let idleResolve;
  let ended = false;

  const pump = async () => {
    while (running < concurrency && q.length) {
      if (shouldCancel && shouldCancel()) {
        q.length = 0;
        if (running === 0 && idleResolve) idleResolve();
        return;
      }
      const task = q.shift();
      running++;
      const { item, idx } = task;
      if (onLog) onLog({ logKey: 'log.downloading.start', logVars: { cur: done+1, total, artist: item.uploader, title: item.title }, fallback: `📥 İndiriliyor (${done + 1}/${total}): ${item.uploader} - ${item.title}` });
      try {
        const filePath = await downloadSingleYouTubeVideo(item.webpage_url, `${jobId}_${idx}`, downloadDir);
        results.push({ index: item.index, title: item.title, uploader: item.uploader, filePath, item });
        if (onLog) onLog({ logKey: 'log.downloading.ok', logVars: { artist: item.uploader, title: item.title }, fallback: `✅ İndirildi: ${item.uploader} - ${item.title}` });
      } catch (e) {
        results.push({ index: item.index, title: item.title, uploader: item.uploader, filePath: null, item, error: e.message });
        if (onLog) onLog({ logKey: 'log.downloading.err', logVars: { artist: item.uploader, title: item.title, err: e.message }, fallback: `❌ İndirme hatası: ${item.uploader} - ${item.title} - ${e.message}` });
      } finally {
        done++;
        if (onProgress) onProgress(done, total);
        running--;
        if (shouldCancel && shouldCancel()) {
          q.length = 0;
          if (running === 0 && idleResolve) idleResolve();
          return;
        }
        if (q.length) pump();
        else if (ended && running === 0 && idleResolve) idleResolve();
      }
    }
  };

  return {
    enqueue(item, idxZeroBased) {
      total++;
      q.push({ item, idx: idxZeroBased });
      pump();
    },
    async waitForIdle() {
      if (running === 0 && q.length === 0) return;
      return new Promise(res => { idleResolve = res; });
    },
    end() {
      ended = true;
      if (q.length === 0 && running === 0 && idleResolve) idleResolve();
    },
    getResults() {
      return results.sort((a,b) => a.index - b.index);
    }
  };
}
