
const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

// Server health check
app.get('/', (_req, res) => {
  res.json({
    app: 'Meet Lite signaling server',
    status: 'ok'
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok'
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// roomId -> Map(socketId, { name, cameraOff })
const rooms = new Map();

// Generate a six-character meeting code.
function makeRoomCode() {
  return crypto
    .randomBytes(4)
    .toString('hex')
    .slice(0, 6)
    .toUpperCase();
}

function createUniqueRoomCode() {
  let code;

  do {
    code = makeRoomCode();
  } while (rooms.has(code));

  return code;
}

// Get a safe participant object for clients.
function getParticipant(id, user) {
  return {
    id,
    name: user.name,
    cameraOff: Boolean(user.cameraOff)
  };
}

// Remove a participant from their current room.
function leaveRoom(socket) {
  const roomId = socket.data.roomId;

  if (!roomId) return;

  const room = rooms.get(roomId);

  if (room) {
    room.delete(socket.id);

    // Notify remaining participants.
    socket.to(roomId).emit('user-left', {
      id: socket.id
    });

    // Delete empty rooms.
    if (room.size === 0) {
      rooms.delete(roomId);
      console.log(`Room deleted: ${roomId}`);
    }
  }

  socket.leave(roomId);

  delete socket.data.roomId;
  delete socket.data.name;
}

// Join an existing room.
function joinExistingRoom(
  socket,
  roomId,
  name,
  acknowledge
) {
  const key = String(roomId || '')
    .trim()
    .toUpperCase()
    .slice(0, 20);

  const displayName = String(name || 'Guest')
    .trim()
    .slice(0, 28) || 'Guest';

  if (!key) {
    acknowledge?.({
      ok: false,
      error: 'Enter a meeting code first.'
    });
    return;
  }

  const room = rooms.get(key);

  if (!room) {
    acknowledge?.({
      ok: false,
      error: 'Meeting not found. Check the code or ask the host to create a meeting.'
    });
    return;
  }

  // Leave the previous room first, if necessary.
  if (socket.data.roomId) {
    leaveRoom(socket);
  }

  // Get existing participants before adding the new participant.
  const existingUsers = [...room.entries()].map(
    ([id, user]) => getParticipant(id, user)
  );

  socket.join(key);

  socket.data.roomId = key;
  socket.data.name = displayName;

  // New participants start with their camera on.
  const newUser = {
    name: displayName,
    cameraOff: false
  };

  room.set(socket.id, newUser);

  // Send the existing participants to the new participant.
  socket.emit('room-users', existingUsers);

  // Notify existing participants about the new participant.
  socket.to(key).emit(
    'user-joined',
    getParticipant(socket.id, newUser)
  );

  acknowledge?.({
    ok: true,
    roomId: key
  });

  console.log(
    `${displayName} joined room ${key}`
  );
}

// Socket.IO connections.
io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  // CREATE ROOM
  socket.on('create-room', (payload = {}, acknowledge) => {
    if (socket.data.roomId) {
      leaveRoom(socket);
    }

    const roomId = createUniqueRoomCode();

    rooms.set(roomId, new Map());

    joinExistingRoom(
      socket,
      roomId,
      payload.name,
      acknowledge
    );

    console.log(
      `Room created: ${roomId} by ${socket.id}`
    );
  });

  // JOIN ROOM
  // This event only joins existing rooms.
  socket.on('join-room', (payload = {}, acknowledge) => {
    joinExistingRoom(
      socket,
      payload.roomId,
      payload.name,
      acknowledge
    );
  });

  // CAMERA ON / OFF
  socket.on('camera-state', payload => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    const room = rooms.get(roomId);

    if (!room || !room.has(socket.id)) return;

    // Accept either { cameraOff: true/false } or a boolean.
    const cameraOff = typeof payload === 'boolean'
      ? payload
      : Boolean(payload?.cameraOff);

    const user = room.get(socket.id);

    user.cameraOff = cameraOff;

    room.set(socket.id, user);

    // Notify everyone else in the room.
    socket.to(roomId).emit('camera-state', {
      id: socket.id,
      cameraOff
    });

    console.log(
      `Camera ${cameraOff ? 'OFF' : 'ON'}: ${socket.id} in ${roomId}`
    );
  });

  // WEBRTC SIGNALING
  // Audio and video are transmitted peer-to-peer.
  // This server only relays signaling messages.
  const signalingEvents = [
    'offer',
    'answer',
    'ice-candidate'
  ];

  for (const event of signalingEvents) {
    socket.on(event, payload => {
      const target = payload?.to;
      const roomId = socket.data.roomId;

      if (!target || !roomId) return;

      const room = rooms.get(roomId);

      // Only allow signaling to participants in the same room.
      if (!room || !room.has(socket.id) || !room.has(target)) {
        return;
      }

      io.to(target).emit(event, {
        ...payload,
        from: socket.id
      });
    });
  }

  // LEAVE ROOM
  socket.on('leave-room', () => {
    leaveRoom(socket);

    console.log(
      'Participant left:', socket.id
    );
  });

  // DISCONNECT
  socket.on('disconnect', reason => {
    leaveRoom(socket);

    console.log(
      `Client disconnected: ${socket.id} (${reason})`
    );
  });
});

// START SERVER
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Meet Lite signaling server listening on port ${PORT}`
  );
});
