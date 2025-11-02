import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import "dotenv/config";
import formatsRoute from "./routes/formats.js";
import spotifyRoute from "./routes/spotify.js";
import playlistRoute from "./routes/playlist.js";
import jobsRoute from "./routes/jobs.js";
import downloadRoute from "./routes/download.js";
import { sendError } from "./modules/utils.js";
import settingsRoute from "./modules/settings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
const OUTPUT_DIR = path.resolve(process.cwd(), "outputs");
const TEMP_DIR   = path.resolve(process.cwd(), "temp");

[UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) =>
    cb(null, `${crypto.randomBytes(8).toString("hex")}_${file.originalname}`)
});
export const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.use(formatsRoute);
app.use(spotifyRoute);
app.use(playlistRoute);
app.use(jobsRoute);
app.use(downloadRoute);
app.use("/api", settingsRoute);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return sendError(res, "INTERNAL", "File too large", 413);
  }
  if (err) {
    console.error("Unhandled error middleware:", err);
    return sendError(res, "INTERNAL", err.message || "internal", 500);
  }
  next();
});

const PORT = process.env.PORT || 5174;
app.listen(PORT, () => {
  console.log(`🚀 Server http://localhost:${PORT} running`);
  console.log(`📁 Uploads: ${UPLOAD_DIR}`);
  console.log(`📁 Outputs: ${OUTPUT_DIR}`);
  console.log(`📁 Temp: ${TEMP_DIR}`);
  console.log("\n⚠️  yt-dlp required for YouTube support");
});
