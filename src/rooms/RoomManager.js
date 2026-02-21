const { customAlphabet } = require('nanoid');
const { GameRoom } = require('../game/GameRoom');

const generateCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // code -> GameRoom
    this.playerRoomMap = new Map(); // socketId -> roomCode
  }

  createRoom(socketId, playerName) {
    const code = this._generateUniqueCode();
    const room = new GameRoom(code, this.io);
    this.rooms.set(code, room);

    const result = room.addPlayer(socketId, playerName, true);
    if (result.success) {
      this.playerRoomMap.set(socketId, code);
    }
    return { success: true, code, player: result.player };
  }

  joinRoom(socketId, code, playerName) {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return { success: false, error: 'Room not found' };
    if (room.isFull()) return { success: false, error: 'Room is full' };
    if (room.gameState !== 'lobby') return { success: false, error: 'Game already in progress' };

    const result = room.addPlayer(socketId, playerName, false);
    if (!result.success) return result;

    this.playerRoomMap.set(socketId, code.toUpperCase());
    return { success: true, code: code.toUpperCase(), player: result.player };
  }

  handleDisconnect(socketId) {
    const code = this.playerRoomMap.get(socketId);
    if (!code) return;

    const room = this.rooms.get(code);
    if (!room) return;

    room.removePlayer(socketId);
    this.playerRoomMap.delete(socketId);

    if (room.isEmpty()) {
      room.destroy();
      this.rooms.delete(code);
      console.log(`[ROOM] Destroyed empty room ${code}`);
    }
  }

  getRoom(socketId) {
    const code = this.playerRoomMap.get(socketId);
    return code ? this.rooms.get(code) : null;
  }

  getRoomByCode(code) {
    return this.rooms.get(code.toUpperCase());
  }

  _generateUniqueCode() {
    let code;
    do { code = generateCode(); } while (this.rooms.has(code));
    return code;
  }
}

module.exports = { RoomManager };
