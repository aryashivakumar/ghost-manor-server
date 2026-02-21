/**
 * SocketHandlers
 * Registers all socket event listeners for a connected client.
 */

function registerSocketHandlers(io, socket, roomManager) {
  // ── Room Events ─────────────────────────────────────────

  socket.on('room:create', ({ playerName }, callback) => {
    try {
      const result = roomManager.createRoom(socket.id, playerName || 'Player');
      socket.join(result.code);
      callback({ success: true, code: result.code, player: result.player });
    } catch (e) {
      callback({ success: false, error: e.message });
    }
  });

  socket.on('room:join', ({ code, playerName }, callback) => {
    try {
      const result = roomManager.joinRoom(socket.id, code, playerName || 'Player');
      if (!result.success) return callback(result);
      socket.join(result.code);
      callback({ success: true, code: result.code, player: result.player });
    } catch (e) {
      callback({ success: false, error: e.message });
    }
  });

  socket.on('room:ready', ({ ready }) => {
    const room = roomManager.getRoom(socket.id);
    if (!room) return;
    room.setReady(socket.id, ready !== false);
  });

  socket.on('room:leave', () => {
    roomManager.handleDisconnect(socket.id);
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
  });

  // ── Game Input ───────────────────────────────────────────

  /**
   * Input packet shape:
   * {
   *   w: bool, a: bool, s: bool, d: bool,
   *   shift: bool,
   *   yaw: number,        // radians, player facing angle
   *   attack: bool,       // ghost only
   *   revive: bool,       // hunter only
   *   flashlightToggle: bool | undefined,  // only sent on change
   * }
   */
  socket.on('input', (input) => {
    const room = roomManager.getRoom(socket.id);
    if (!room) return;
    // Basic validation
    if (typeof input !== 'object' || Array.isArray(input)) return;
    // Sanitize
    const sanitized = {
      w: !!input.w,
      a: !!input.a,
      s: !!input.s,
      d: !!input.d,
      shift: !!input.shift,
      yaw: typeof input.yaw === 'number' ? Math.max(-Math.PI, Math.min(Math.PI, input.yaw)) : 0,
      attack: !!input.attack,
      revive: !!input.revive,
      flashlightToggle: input.flashlightToggle,
    };
    room.receiveInput(socket.id, sanitized);
  });

  // ── Chat (optional) ──────────────────────────────────────

  socket.on('chat:message', ({ text }) => {
    const room = roomManager.getRoom(socket.id);
    if (!room || typeof text !== 'string') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    io.to(room.code).emit('chat:message', {
      from: player.name,
      color: player.color || 'white',
      text: text.slice(0, 120),
    });
  });
}

module.exports = { registerSocketHandlers };
