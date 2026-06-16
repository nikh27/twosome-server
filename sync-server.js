const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const cloudinary = require("cloudinary").v2;
const fs         = require("fs");
const path       = require("path");

// ── Cloudinary config (set these on Render as environment variables) ───────
cloudinary.config({
  cloud_name : process.env.CLOUDINARY_CLOUD_NAME,
  api_key    : process.env.CLOUDINARY_API_KEY,
  api_secret : process.env.CLOUDINARY_API_SECRET,
});

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());

// ── Cloudinary Direct Fetch ──────────────────────────────────────────────────
async function fetchCloudinaryMovies() {
  try {
    const result = await cloudinary.api.resources({
      resource_type : "video",
      max_results   : 100,
      type          : "upload"
    });

    return result.resources.map(resource => ({
      id                 : resource.public_id,
      title              : resource.public_id
                             .replace(/_/g, " ")
                             .replace(/-/g, " ")
                             .split(" ")
                             .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                             .join(" "),
      description        : "",
      year               : new Date(resource.created_at).getFullYear(),
      duration           : formatDuration(resource.duration || 0),
      genre              : [],
      sizeMb             : Math.round(resource.bytes / (1024 * 1024)),
      cloudinaryPublicId : resource.public_id,
      cloudName          : cloudinary.config().cloud_name,
      thumbnailUrl       : cloudinary.url(resource.public_id, {
        resource_type : "video",
        format        : "jpg",
        transformation: [{ width: 400, height: 220, crop: "fill", start_offset: "5" }]
      }),
      downloadUrl : cloudinary.url(resource.public_id, {
        resource_type : "video",
        format        : "mp4"
      })
    }));
  } catch (err) {
    console.error("Cloudinary fetch error:", err.message);
    return [];
  }
}

// ── REST API ──────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.send("🎬 Twosome Sync Server is running!");
});
app.get("/ping", (req, res) => res.send("pong"));

// GET /api/movies — returns the full movie catalog dynamically from Cloudinary
app.get("/api/movies", async (req, res) => {
  const movies = await fetchCloudinaryMovies();
  res.json({ success: true, movies });
});

// GET /api/movies/search?q=interstellar — search by title
app.get("/api/movies/search", async (req, res) => {
  const query  = (req.query.q || "").toLowerCase();
  const movies = await fetchCloudinaryMovies();
  const result = movies.filter(m =>
    m.title.toLowerCase().includes(query) ||
    (m.genre || []).some(g => g.toLowerCase().includes(query))
  );
  res.json({ success: true, movies: result });
});

// GET /api/movies/:id — single movie details
app.get("/api/movies/:id", async (req, res) => {
  const movies = await fetchCloudinaryMovies();
  const movie  = movies.find(m => m.id === req.params.id);
  if (!movie) return res.status(404).json({ success: false, error: "Movie not found" });
  res.json({ success: true, movie });
});

// POST /api/movies/refresh — backward compatibility for Android app's refresh button
app.post("/api/movies/refresh", async (req, res) => {
  const movies = await fetchCloudinaryMovies();
  res.json({ success: true, count: movies.length, movies });
});

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Socket.io — Sync Room Logic ───────────────────────────────────────────

const rooms     = {};
const roomState = {};  // { roomCode → { isPlaying, positionMs, movieId, updatedAt } }

io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // JOIN ROOM — client sends roomCode + username + movieId they've downloaded
  socket.on("join-room", ({ roomCode, username, movieId }) => {
    if (!roomCode) return;

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.username = username || "Friend";
    socket.data.movieId  = movieId;

    if (!rooms[roomCode]) rooms[roomCode] = new Set();
    rooms[roomCode].add(socket.id);

    console.log(`[room:${roomCode}] ${username} joined (movie: ${movieId})`);
    socket.to(roomCode).emit("user-joined", { username: socket.data.username, movieId });

    // Send current state to late joiner
    if (roomState[roomCode]) {
      const state   = roomState[roomCode];
      const elapsed = state.isPlaying ? Date.now() - state.updatedAt : 0;
      socket.emit("sync-state", {
        isPlaying  : state.isPlaying,
        positionMs : state.positionMs + elapsed,
        movieId    : state.movieId,
      });
    }
  });

  // CONTROL events — play / pause / seek
  socket.on("control", ({ type, positionMs }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    roomState[roomCode] = {
      isPlaying  : type === "play",
      positionMs : positionMs || 0,
      movieId    : socket.data.movieId,
      updatedAt  : Date.now(),
    };

    socket.to(roomCode).emit("control", {
      type,
      positionMs : positionMs || 0,
      from       : socket.data.username,
    });
  });

  // BUFFERING
  socket.on("buffering", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    io.to(roomCode).emit("control", { type: "pause", positionMs: 0, from: "sync-server" });
  });

  socket.on("buffer-ready", ({ positionMs }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    socket.to(roomCode).emit("control", { type: "play", positionMs, from: "sync-server" });
  });

  // CHAT
  socket.on("chat", ({ message }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !message) return;
    socket.to(roomCode).emit("chat", {
      sender  : socket.data.username,
      message : message,
    });
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (roomCode && rooms[roomCode]) {
      rooms[roomCode].delete(socket.id);
      if (rooms[roomCode].size === 0) {
        delete rooms[roomCode];
        delete roomState[roomCode];
      }
    }
    if (roomCode) {
      socket.to(roomCode).emit("user-left", { username: socket.data.username });
    }
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎬 Twosome sync server running on port ${PORT}`);
  console.log(`📽  Movie catalog: ${loadMovies().length} movies loaded`);
});
