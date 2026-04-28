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
const COOKIES_PATH = "/etc/secrets/cookies.txt";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Player clients to try in order ───────────────────────────────────────────
const PLAYER_CLIENTS = [
  "tv_embedded",
  "android",
  "ios",
  "web_embedded",
  "mweb",
];

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
app.use(bodyParser.json());

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`📁 Created downloads dir: ${OUTPUT_DIR}`);
}

// Check if cookies file exists on startup
const cookiesExist = fs.existsSync(COOKIES_PATH);
console.log(cookiesExist
  ? `🍪 Cookies file found at ${COOKIES_PATH}`
  : `⚠️  No cookies file at ${COOKIES_PATH} — will try without cookies`
);

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

// ── Try one player client ─────────────────────────────────────────────────────
function tryDownload(url, playerClient) {
  return new Promise((resolve, reject) => {
    console.log(`🎬 Trying player client: ${playerClient}`);

    const outputTemplate = path.join(OUTPUT_DIR, "%(title)s.%(ext)s");

    // Build args — inject cookies only if the file exists
    const args = ["-m", "yt_dlp"];

    if (cookiesExist) {
      args.push("--cookies", COOKIES_PATH);
    }

    args.push(
      "--extractor-args", `youtube:player_client=${playerClient}`,
      "-f", "best[ext=mp4][height<=1080]/best[ext=mp4]/best[height<=720]",
      "-o", outputTemplate,
      "--no-playlist",
      "--print", "after_move:filepath",
      url
    );

    const ytdlp = spawn("python", args);

    let downloadedFile = null;
    let stderrBuf = "";

    ytdlp.stdout.on("data", (data) => {
      const line = data.toString().trim();
      if (line && fs.existsSync(line)) {
        downloadedFile = line;
        console.log(`📄 File confirmed [${playerClient}]: ${downloadedFile}`);
      }
    });

    ytdlp.stderr.on("data", (data) => {
      const text = data.toString();
      process.stderr.write(text);
      stderrBuf += text;
    });

    ytdlp.on("close", (code) => {
      if (code === 0 && downloadedFile && fs.existsSync(downloadedFile)) {
        resolve({ file: downloadedFile, client: playerClient });
      } else {
        const isRetryable =
          stderrBuf.includes("429") ||
          stderrBuf.includes("Sign in to confirm") ||
          stderrBuf.includes("bot");

        reject({
          retryable: isRetryable,
          client: playerClient,
          details: stderrBuf.split("\n").slice(-6).filter(Boolean),
        });
      }
    });

    ytdlp.on("error", (err) => {
      reject({
        retryable: false,
        client: playerClient,
        details: [err.message],
      });
    });
  });
}

// ── Try all clients in sequence ───────────────────────────────────────────────
async function downloadWithFallback(url) {
  let lastError = null;

  for (const client of PLAYER_CLIENTS) {
    try {
      const result = await tryDownload(url, client);
      console.log(`✅ Success with player client: ${client}`);
      return result;
    } catch (err) {
      console.warn(`⚠️  Client [${err.client}] failed. Retryable: ${err.retryable}`);
      lastError = err;

      if (!err.retryable) {
        console.error(`🛑 Non-retryable error, stopping fallback.`);
        break;
      }
    }
  }

  throw lastError;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "yt-dlp server is running 🚀",
    cookiesLoaded: cookiesExist,
    playerClients: PLAYER_CLIENTS,
  });
});

app.post("/download", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "Missing 'url' in request body." });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: "Invalid URL provided." });
  }

  console.log(`\n📥 Download request: ${url}`);

  try {
    const { file, client } = await downloadWithFallback(url);
    const publicUrl = await uploadToSupabase(file);

    return res.json({
      status: "success",
      message: "Video downloaded and stored in Supabase.",
      playerClient: client,
      fileName: path.basename(publicUrl),
      publicUrl,
    });
  } catch (err) {
    console.error("❌ All player clients failed.");

    return res.status(500).json({
      status: "error",
      message: cookiesExist
        ? "All player clients failed even with cookies. Cookies may have expired — re-export and update the secret file."
        : "All player clients failed. Add a cookies.txt secret file to Render to fix this.",
      lastClientTried: err.client,
      details: err.details || [],
    });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`🔄 Fallback order: ${PLAYER_CLIENTS.join(" → ")}`);
});