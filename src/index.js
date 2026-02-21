const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.get('/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── MAP (same as HTML) ─────────────────────────────────────────────
const MC = 52, MR = 32;
const RAW = [
  "0000000000000110011000000000000001100000000000000000",
  "0000000000000110011000000000000001100000000000000000",
  "0011000000000110011000000000000001100000011111100111",
  "0011000000000110011000000000000001100000011111100111",
  "0011000000000000011000000000000001100000000000000000",
  "0011000000000000011000000000000001100000000000000000",
  "0011000000000110000000000000000000100111001111111100",
  "0011000000000110000000000000000000000111001111111100",
  "0011000000000110000000000000000000100110000000001100",
  "0011000000000110011000000000000001100110000000001100",
  "0011111100000110011000000000000001100110000000001100",
  "0001111100000110011000000000000001100110000000000000",
  "0000001100000110011000000000000001100110000000000000",
  "0000001110011110011111111001111111100111111111111100",
  "0000001110011110011111111001111111100111111111111100",
  "0000000000000000011000000000000001100000000000000000",
  "0000000000000000000000000000000000000000000000000000",
  "0011100000000000000000000000000000000000000000000000",
  "0011100111111110000000000000000001100111111111111100",
  "0011100111111110000000000000000001100111111111111100",
  "0000000110000110000000000000000001100000000000001100",
  "0000000110000110011111111001111111100000000000001100",
  "0011111110011110011111111000111111100000000000001100",
  "0011111110011110011000000000000001100000000000001100",
  "0011000000000000011000000000000001100000000000001100",
  "0011000000000000011000000000000001100000000000000000",
  "0011000000000110011000000000000001100000000000000000",
  "0011000000000110011000000000000001100000000000001100",
  "0011111111001110011111111001111111100000000000001100",
  "0011111111001110011111111001111111100000000000001100",
  "0000000000000110000000000000000001100000000000001100",
  "0000000000000110000000000000000001100000000000001100",
];
const MAP = [];
for (let r = 0; r < MR; r++) {
  MAP[r] = [];
  for (let c = 0; c < MC; c++) MAP[r][c] = +RAW[r][c] || 0;
}
for (let c = 0; c < MC; c++) { MAP[0][c] = 1; MAP[MR - 1][c] = 1; }
for (let r = 0; r < MR; r++) { MAP[r][0] = 1; MAP[r][MC - 1] = 1; }

const CELL = 0.62;
const OPEN_CELLS = [];
for (let r = 2; r < MR - 2; r++)
  for (let c = 2; c < MC - 2; c++)
    if (!MAP[r][c]) OPEN_CELLS.push({ r, c });

function randOpen() {
  const cell = OPEN_CELLS[Math.floor(Math.random() * OPEN_CELLS.length)];
  return { x: (cell.c + 0.5) * CELL, z: (cell.r + 0.5) * CELL };
}

function solid(wx, wz) {
  const c = Math.floor(wx / CELL), r = Math.floor(wz / CELL);
  return r < 0 || r >= MR || c < 0 || c >= MC || !!MAP[r][c];
}
const PR = 0.28 * CELL;
function canWalk(wx, wz) {
  return !solid(wx - PR, wz - PR) && !solid(wx + PR, wz - PR) &&
         !solid(wx - PR, wz + PR) && !solid(wx + PR, wz + PR);
}
function tryMovePos(pos, nx, nz) {
  if (canWalk(nx, nz)) { pos.x = nx; pos.z = nz; }
  else if (canWalk(nx, pos.z)) { pos.x = nx; }
  else if (canWalk(pos.x, nz)) { pos.z = nz; }
}

// ── ROOM MANAGER ──────────────────────────────────────────────────
const rooms = new Map(); // code -> Room

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // socketId -> playerObj
    this.phase = 'lobby'; // lobby | game | ended
    this.ghost = null;
    this.batteries = [];
    this.litAmt = 0;
    this.litTimer = 30 + Math.random() * 20;
    this.batSpawnTimer = 8;
    this.tick = null;
    this.ghostAI = null; // socketId or null if AI
  }

  addPlayer(id, name) {
    this.players.set(id, {
      id, name,
      role: null, // 'ghost' | 'hunter'
      x: 0, y: 0, z: 0,
      yaw: 0, pitch: 0,
      battery: 1,
      flashOn: true,
      lives: 3,
      alive: true,
      ready: false,
      color: `hsl(${Math.floor(Math.random() * 360)},80%,60%)`,
    });
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.players.size === 0) this.destroy();
  }

  lobbyState() {
    return Array.from(this.players.values()).map(p => ({
      id: p.id, name: p.name, ready: p.ready, color: p.color
    }));
  }

  startGame() {
    this.phase = 'game';
    const pArr = Array.from(this.players.values());

    // Assign roles: first ready player or random becomes ghost
    const shuffled = pArr.sort(() => Math.random() - 0.5);
    shuffled[0].role = 'ghost';
    for (let i = 1; i < shuffled.length; i++) shuffled[i].role = 'hunter';

    // Spawn positions
    const ghostSpawn = randOpen();
    shuffled[0].x = ghostSpawn.x; shuffled[0].z = ghostSpawn.z;
    shuffled[0].y = 0.33 * CELL;

    for (let i = 1; i < shuffled.length; i++) {
      const sp = randOpen();
      shuffled[i].x = sp.x; shuffled[i].z = sp.z;
      shuffled[i].y = 0.52 * CELL;
    }

    // Ghost state
    this.ghost = {
      hp: 100,
      stunT: 0,
      visible: false,
      minimapVis: false,
    };

    // Spawn initial batteries (reduced from 4 to 2)
    this.batteries = [];
    for (let i = 0; i < 2; i++) this.spawnBattery();

    // Start tick
    let last = Date.now();
    this.tick = setInterval(() => {
      const now = Date.now();
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      this.update(dt);
    }, 50); // 20Hz
  }

  spawnBattery() {
    const pos = randOpen();
    this.batteries.push({ ...pos, y: 0.55 * CELL, id: Math.random().toString(36).slice(2), life: 18 });
  }

  update(dt) {
    if (this.phase !== 'game') return;

    const pArr = Array.from(this.players.values());
    const ghostPlayer = pArr.find(p => p.role === 'ghost');
    const hunters = pArr.filter(p => p.role === 'hunter');

    // Ghost stun
    if (this.ghost.stunT > 0) this.ghost.stunT -= dt;

    // Lightning
    this.litTimer -= dt;
    if (this.litTimer <= 0) {
      this.litAmt = 1.0;
      this.ghost.visible = true;
      this.ghost.minimapVis = true;
      io.to(this.code).emit('lightning:strike');
      setTimeout(() => { this.ghost.visible = false; }, 750);
      setTimeout(() => { this.ghost.minimapVis = false; }, 2300);
      this.litTimer = 35 + Math.random() * 20;
    }
    this.litAmt = Math.max(0, this.litAmt - dt * 3.0);

    // Battery drain for hunters
    for (const h of hunters) {
      if (!h.alive) continue;
      if (h.flashOn) h.battery = Math.max(0, h.battery - dt * 0.014);
      if (h.battery <= 0) h.flashOn = false;
    }

    // Battery spawn (reduced max from 5 to 3)
    this.batSpawnTimer -= dt;
    if (this.batSpawnTimer <= 0 && this.batteries.length < 3) {
      this.spawnBattery();
      this.batSpawnTimer = 9 + Math.random() * 7;
    }

    // Battery lifetime + pickup
    this.batteries = this.batteries.filter(b => {
      b.life -= dt;
      for (const h of hunters) {
        if (!h.alive) continue;
        if (Math.hypot(h.x - b.x, h.z - b.z) < 0.65 * CELL) {
          h.battery = Math.min(1, h.battery + 0.55);
          io.to(h.id).emit('battery:pickup');
          return false;
        }
      }
      return b.life > 0;
    });

    // Check visibility of ghost from each hunter
    if (this.ghost.stunT <= 0) {
      for (const h of hunters) {
        if (!h.alive) continue;
        if (this.isGhostVisible(h, ghostPlayer)) {
          this.ghost.visible = true;
          this.ghost.minimapVis = true;
          // Ghost takes damage if in flashlight
          if (h.flashOn && h.battery > 0) {
            this.ghost.hp = Math.max(0, this.ghost.hp - 6 * dt);
          }
        }
      }
    }

    // Ghost attacks hunters (proximity)
    if (ghostPlayer && this.ghost.stunT <= 0) {
      for (const h of hunters) {
        if (!h.alive) continue;
        const d = Math.hypot(h.x - ghostPlayer.x, h.z - ghostPlayer.z);
        if (d < 0.8 * CELL) {
          // Ghost touched hunter
          if (!h._attackCd || h._attackCd <= 0) {
            h.lives = Math.max(0, h.lives - 1);
            h._attackCd = 2.5;
            io.to(h.id).emit('hunter:hit', { lives: h.lives });
            if (h.lives <= 0) {
              h.alive = false;
              io.to(this.code).emit('hunter:eliminated', { hunterId: h.id });
            }
          }
        }
        if (h._attackCd > 0) h._attackCd -= dt;
      }
    }

    // Win condition
    const aliveHunters = hunters.filter(h => h.alive);
    if (this.ghost.hp <= 0) {
      this.endGame('hunters');
      return;
    }
    if (aliveHunters.length === 0 && hunters.length > 0) {
      this.endGame('ghost');
      return;
    }

    // Broadcast state to all players
    this.broadcastState();
  }

  isGhostVisible(hunter, ghostPlayer) {
    if (!hunter.flashOn || hunter.battery <= 0 || !ghostPlayer) return false;
    const dx = ghostPlayer.x - hunter.x;
    const dz = ghostPlayer.z - hunter.z;
    const d = Math.hypot(dx, dz);
    const FLASH_RANGE = 5.5 * CELL;
    if (d > FLASH_RANGE) return false;
    const cos = (dx * Math.sin(hunter.yaw) + dz * Math.cos(hunter.yaw)) / d;
    if (cos < 0.65) return false;
    // Ray check
    const steps = Math.ceil(d / 0.15) + 1;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (solid(hunter.x + dx * t, hunter.z + dz * t)) return false;
    }
    return true;
  }

  broadcastState() {
    const pArr = Array.from(this.players.values());
    const ghostP = pArr.find(p => p.role === 'ghost');

    for (const receiver of pArr) {
      // Each player gets a state packet tailored to them
      const isGhost = receiver.role === 'ghost';

      // Determine if ghost is visible to this player
      let ghostVisible = false;
      let ghostMinimapVisible = false;
      if (ghostP) {
        if (isGhost) {
          ghostVisible = true; ghostMinimapVisible = true;
        } else {
          ghostVisible = this.ghost.visible || this.isGhostVisible(receiver, ghostP);
          ghostMinimapVisible = this.ghost.minimapVis || ghostVisible;
        }
      }

      // Ghost proximity for vignette
      let ghostDist = 999;
      if (ghostP) ghostDist = Math.hypot(receiver.x - ghostP.x, receiver.z - ghostP.z);

      const packet = {
        players: pArr.map(p => ({
          id: p.id,
          role: p.role,
          x: p.x, y: p.y, z: p.z,
          yaw: p.yaw, pitch: p.pitch,
          battery: p.battery,
          flashOn: p.flashOn,
          lives: p.lives,
          alive: p.alive,
          color: p.color,
          name: p.name,
        })),
        ghost: {
          hp: this.ghost.hp,
          visible: ghostVisible,
          minimapVis: ghostMinimapVisible,
          stunT: this.ghost.stunT,
        },
        batteries: this.batteries,
        litAmt: this.litAmt,
        ghostDist,
        myId: receiver.id,
      };

      io.to(receiver.id).emit('game:state', packet);
    }
  }

  endGame(winner) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    io.to(this.code).emit('game:end', { winner });
    // Auto-destroy after 30s
    setTimeout(() => this.destroy(), 30000);
  }

  destroy() {
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    rooms.delete(this.code);
  }
}

// ── SOCKET EVENTS ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('room:create', ({ playerName }, cb) => {
    const code = genCode();
    const room = new Room(code);
    rooms.set(code, room);
    room.addPlayer(socket.id, playerName || 'Player');
    socket.join(code);
    currentRoom = room;
    cb({ ok: true, code, playerId: socket.id });
    io.to(code).emit('lobby:state', { players: room.lobbyState() });
  });

  socket.on('room:join', ({ code, playerName }, cb) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.phase !== 'lobby') return cb({ ok: false, error: 'Game already started' });
    if (room.players.size >= 5) return cb({ ok: false, error: 'Room full' });
    room.addPlayer(socket.id, playerName || 'Player');
    socket.join(code.toUpperCase());
    currentRoom = room;
    cb({ ok: true, code: code.toUpperCase(), playerId: socket.id });
    io.to(code.toUpperCase()).emit('lobby:state', { players: room.lobbyState() });
  });

  socket.on('room:ready', ({ ready }) => {
    if (!currentRoom) return;
    const p = currentRoom.players.get(socket.id);
    if (p) p.ready = ready;
    io.to(currentRoom.code).emit('lobby:state', { players: currentRoom.lobbyState() });

    // Start if all players ready and at least 2 players
    const pArr = Array.from(currentRoom.players.values());
    if (pArr.length >= 2 && pArr.every(p => p.ready) && currentRoom.phase === 'lobby') {
      currentRoom.startGame();
      io.to(currentRoom.code).emit('game:start', {
        players: Array.from(currentRoom.players.values()).map(p => ({
          id: p.id, role: p.role, color: p.color, lives: p.lives, name: p.name
        }))
      });
    }
  });

  socket.on('input', (input) => {
    if (!currentRoom || currentRoom.phase !== 'game') return;
    const p = currentRoom.players.get(socket.id);
    if (!p || !p.alive) return;

    const { dx, dz, yaw, pitch, flashOn, attack } = input;
    const spd = 2.2 * 0.05; // max per-tick movement

    // Apply movement
    if (typeof dx === 'number' && typeof dz === 'number') {
      const ndx = Math.max(-spd, Math.min(spd, dx));
      const ndz = Math.max(-spd, Math.min(spd, dz));
      tryMovePos(p, p.x + ndx, p.z + ndz);
    }

    if (typeof yaw === 'number') p.yaw = yaw;
    if (typeof pitch === 'number') p.pitch = Math.max(-1.05, Math.min(1.05, pitch));
    if (typeof flashOn === 'boolean') {
      if (p.role === 'hunter') p.flashOn = flashOn;
    }

    // Attack: hunter clicks to hit ghost
    if (attack && p.role === 'hunter') {
      const ghostP = Array.from(currentRoom.players.values()).find(q => q.role === 'ghost');
      if (ghostP && currentRoom.ghost.stunT <= 0) {
        const d = Math.hypot(p.x - ghostP.x, p.z - ghostP.z);
        if (d < 8 && currentRoom.isGhostVisible(p, ghostP) && p.flashOn && p.battery > 0) {
          currentRoom.ghost.hp = Math.max(0, currentRoom.ghost.hp - 1);
          currentRoom.ghost.stunT = 1.5;
          io.to(currentRoom.code).emit('ghost:hit', { hp: currentRoom.ghost.hp });
        }
      }
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      currentRoom.removePlayer(socket.id);
      if (currentRoom.players.size > 0) {
        io.to(currentRoom.code).emit('lobby:state', { players: currentRoom.lobbyState() });
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Ghost Manor server running on port ${PORT}`));
