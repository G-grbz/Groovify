export const jobs = new Map();
export const spotifyMapTasks = new Map();
export const spotifyDownloadTasks = new Map();

const GC_INTERVAL_MS = 60 * 60 * 1000;
const JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const procByJob = new Map();

export function registerJobProcess(jobId, child) {
  if (!jobId || !child) return;
  let set = procByJob.get(jobId);
  if (!set) { set = new Set(); procByJob.set(jobId, set); }
  set.add(child);
  const cleanup = () => { try { set.delete(child); } catch {} };
  child.on?.('exit', cleanup);
  child.on?.('close', cleanup);
}

export function killJobProcesses(jobId) {
  const set = procByJob.get(jobId);
  if (!set || set.size === 0) return 0;
  let killed = 0;
  for (const ch of Array.from(set)) {
    try { ch.kill?.('SIGTERM'); setTimeout(()=>{ try { ch.kill?.('SIGKILL'); } catch {} }, 500); killed++; } catch {}
  }
  return killed;
}

setInterval(() => {
  const now = Date.now();

  for (const [id, job] of jobs.entries()) {
    if (!job?.createdAt) continue;
    const finished = job.status === "completed" || job.status === "error";
    if (finished && (now - new Date(job.createdAt).getTime()) > JOB_MAX_AGE_MS) {
      jobs.delete(id);
      procByJob.delete(id);
    }
  }

  for (const [id, task] of spotifyMapTasks.entries()) {
    if (!task?.createdAt) continue;
    const finished = task.status === "completed" || task.status === "error";
    if (finished && (now - new Date(task.createdAt).getTime()) > JOB_MAX_AGE_MS) {
      spotifyMapTasks.delete(id);
    }
  }
}, GC_INTERVAL_MS);

export { procByJob };
