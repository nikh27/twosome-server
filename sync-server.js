const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// rooms: { roomCode -> Set of socket IDs }
const rooms = {};

// Track each socket's current playback state (for late joiners)
const roomState = {};
// roomState[roomCode] = { isPlaying, positionMs, updatedAt }

app.get("/", (req, res) => {
  res.send("🎬 Twosome Sync Server is running!");
});

// Health check endpoint (Render pings this to keep free tier alive)
app.get("/ping", (req, res) => res.send("pong"));

io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── JOIN ROOM ────────────────────────────────────────────────────────────
  socket.on("join-room", ({ roomCode, username }) => {
    if (!roomCode) return;

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.username = username || "Friend";

    if (!rooms[roomCode]) rooms[roomCode] = new Set();
    rooms[roomCode].add(socket.id);

    console.log(`[room:${roomCode}] ${username} joined (${rooms[roomCode].size} users)`);

    // Tell everyone else someone joined
    socket.to(roomCode).emit("user-joined", { username: socket.data.username });

    // Send the new joiner the current state so they're in sync immediately
    if (roomState[roomCode]) {
      const state = roomState[roomCode];
      // Estimate current position accounting for time elapsed since last update
      const elapsed = state.isPlaying
        ? Date.now() - state.updatedAt
        : 0;
      socket.emit("sync-state", {
        isPlaying  : state.isPlaying,
        positionMs : state.positionMs + elapsed,
      });
    }
  });

  // ── CONTROL EVENTS (play / pause / seek) ─────────────────────────────────
  // Both users are symmetric — whoever sends, the other receives
  socket.on("control", ({ type, positionMs }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    console.log(`[room:${roomCode}] ${socket.data.username}: ${type} @ ${positionMs}ms`);

    // Save state for late joiners
    roomState[roomCode] = {
      isPlaying : type === "play",
      positionMs: positionMs || 0,
      updatedAt : Date.now(),
    };

    // Broadcast to everyone ELSE in the room
    socket.to(roomCode).emit("control", {
      type      : type,
      positionMs: positionMs || 0,
      from      : socket.data.username,
    });
  });

  // ── BUFFERING (slowest player wins) ──────────────────────────────────────
  socket.on("buffering", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    console.log(`[room:${roomCode}] ${socket.data.username} is buffering — pausing all`);
    // Tell everyone to pause while this user buffers
    io.to(roomCode).emit("control", { type: "pause", positionMs: 0, from: "sync-server" });
  });

  socket.on("buffer-ready", ({ positionMs }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    console.log(`[room:${roomCode}] ${socket.data.username} buffer ready`);
    // Tell everyone to resume
    socket.to(roomCode).emit("control", { type: "play", positionMs, from: "sync-server" });
  });

  // ── CHAT ─────────────────────────────────────────────────────────────────
  socket.on("chat", ({ message }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !message) return;
    console.log(`[room:${roomCode}] chat: ${socket.data.username}: ${message}`);
    socket.to(roomCode).emit("chat", {
      sender : socket.data.username,
      message: message,
    });
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (roomCode && rooms[roomCode]) {
      rooms[roomCode].delete(socket.id);
      if (rooms[roomCode].size === 0) {
        delete rooms[roomCode];
        delete roomState[roomCode];
        console.log(`[room:${roomCode}] empty, cleaned up`);
      }
    }
    console.log(`[-] Disconnected: ${socket.id}`);
    if (roomCode) {
      socket.to(roomCode).emit("user-left", { username: socket.data.username });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎬 Twosome sync server running on port ${PORT}`);
});
