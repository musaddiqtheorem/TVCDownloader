# yt-dlp Server

Express server that downloads videos via yt-dlp and uploads them to Supabase Storage.

## Local Setup

### Prerequisites
- Node.js 18+
- Python 3.8+

### Install & Run

```bash
# Install Node dependencies
npm install

# Install yt-dlp
pip install yt-dlp

# Copy and fill in your env vars
cp .env.example .env

# Start the server
npm run dev
```

Server runs at: http://localhost:3000

### Test

```bash
curl -X POST http://localhost:3000/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

## Deploy to Render (Recommended)

1. Push this project to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Set the following:
   - **Environment**: Node
   - **Build command**: `npm install && pip install yt-dlp`
   - **Start command**: `node server.js`
5. Add environment variables in the Render dashboard:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
6. Click Deploy

## API

### GET /
Health check. Returns `{ status: "ok" }`.

### POST /download
Downloads a video and uploads it to Supabase.

**Body:**
```json
{ "url": "https://www.youtube.com/watch?v=..." }
```

**Response:**
```json
{
  "status": "success",
  "message": "Video downloaded and stored in Supabase.",
  "fileName": "my-video.mp4",
  "publicUrl": "https://your-project.supabase.co/storage/v1/object/public/video-downloads/my-video.mp4"
}
```

## Notes

- Videos are temporarily saved to `./downloads/` then deleted after upload
- Supabase bucket must be set to **public** for `publicUrl` to work
- On Render free tier, server sleeps after 15 min inactivity (30s cold start)
