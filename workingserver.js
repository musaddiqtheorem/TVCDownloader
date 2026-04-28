require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { createClient } = require("@supabase/supabase-js");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const OUTPUT_DIR = path.join(__dirname, "downloads");
const SUPABASE_BUCKET = "video-downloads";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
app.use(bodyParser.json());

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`📁 Created downloads dir: ${OUTPUT_DIR}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitizeFilename(filename) {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isValidUrl(str) {
  try {
    const url = new URL(str);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

async function uploadToSupabase(filePath) {
  const originalName = path.basename(filePath);
  const bucketKey = sanitizeFilename(originalName);

  console.log(`⬆️  Uploading: ${originalName} → ${bucketKey}`);

  const fileBuffer = fs.readFileSync(filePath);

  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(bucketKey, fileBuffer, {
      contentType: "video/mp4",
      upsert: true,
    });

  if (error) throw error;

  const { data: urlData } = supabase.storage
    .from(SUPABASE_BUCKET)
    .getPublicUrl(data.path);

  fs.unlinkSync(filePath);
  console.log(`✅ Uploaded & local file deleted: ${filePath}`);

  return urlData.publicUrl;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "yt-dlp server is running 🚀" });
});

app.post("/download", (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "Missing 'url' in request body." });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: "Invalid URL provided." });
  }

  console.log(`🎬 Starting download: ${url}`);

  const outputTemplate = path.join(OUTPUT_DIR, "%(title)s.%(ext)s");

  const ytdlp = spawn("python", [
    "-m", "yt_dlp",
    "--extractor-args", "youtube:player_client=default",
    "-f", "best[ext=mp4][height<=1080]/best[ext=mp4]/best[height<=720]",
    "-o", outputTemplate,
    "--no-playlist",
    "--print", "after_move:filepath",
    url,
  ]);

  let downloadedFile = null;
  let stderrBuf = "";

  ytdlp.stdout.on("data", (data) => {
    const line = data.toString().trim();
    if (line && fs.existsSync(line)) {
      downloadedFile = line;
      console.log(`📄 File path confirmed: ${downloadedFile}`);
    }
  });

  ytdlp.stderr.on("data", (data) => {
    const text = data.toString();
    process.stderr.write(text);
    stderrBuf += text;
  });

  ytdlp.on("close", async (code) => {
    console.log(`🔚 yt-dlp exited with code: ${code}`);

    if (code === 0 && downloadedFile && fs.existsSync(downloadedFile)) {
      try {
        const publicUrl = await uploadToSupabase(downloadedFile);
        return res.json({
          status: "success",
          message: "Video downloaded and stored in Supabase.",
          fileName: path.basename(publicUrl),
          publicUrl,
        });
      } catch (err) {
        console.error("❌ Supabase upload failed:", err.message);
        if (fs.existsSync(downloadedFile)) fs.unlinkSync(downloadedFile);
        return res.status(500).json({
          status: "error",
          message: "Downloaded but Supabase upload failed.",
          details: err.message,
        });
      }
    } else {
      return res.status(500).json({
        status: "error",
        message: "yt-dlp failed to download the video.",
        details: stderrBuf.split("\n").slice(-8).filter(Boolean),
      });
    }
  });

  ytdlp.on("error", (err) => {
    console.error("❌ Failed to spawn yt-dlp:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Could not start yt-dlp process.",
      details: err.message,
    });
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
