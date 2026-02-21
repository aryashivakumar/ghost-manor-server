const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { RoomManager } = require('./rooms/RoomManager');
const { registerSocketHandlers } = require('./game/SocketHandlers');

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 10000,
  pingInterval: 5000,
});

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

const roomManager = new RoomManager(io);

io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);
  registerSocketHandlers(io, socket, roomManager);
  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.id}`);
    roomManager.handleDisconnect(socket.id);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Ghost Mansion Server running on port ${PORT}`);
});
