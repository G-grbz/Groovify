import express from "express";
import { sendOk } from "../modules/utils.js";

const router = express.Router();
router.get("/api/formats", (req,res)=>{
  sendOk(res, { formats: [
    { format: "mp3", bitrates: ["auto","128k","192k","256k","320k"], type: "audio" },
    { format: "flac", bitrates: ["lossless"], type: "audio" },
    { format: "wav",  bitrates: ["lossless"], type: "audio" },
    { format: "ogg",  bitrates: ["auto","128k","192k","256k"], type: "audio" },
    {
      format: "eac3",
      bitrates: ["96k", "128k", "192k", "256k", "384k", "448k", "512k", "640k", "768k"],
      type: "audio"
    },
    {
      format: "ac3",
      bitrates: ["192k", "224k", "256k", "320k", "384k", "448k", "512k", "640k"],
      type: "audio"
    },
    { format: "mp4",  bitrates: ["1080p","720p","480p","360p"], type: "video" },
  ]});
});
export default router;
