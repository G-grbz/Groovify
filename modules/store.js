export const jobs = new Map();
export const spotifyMapTasks = new Map();
export const spotifyDownloadTasks = new Map();

const GC_INTERVAL_MS = 60 * 60 * 1000;
const JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();

  for (const [id, job] of jobs.entries()) {
    if (!job?.createdAt) continue;
    const finished = job.status === "completed" || job.status === "error";
    if (finished && (now - new Date(job.createdAt).getTime()) > JOB_MAX_AGE_MS) {
      jobs.delete(id);
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
