const { PhysicsEngine } = require('./PhysicsEngine');
const { VisibilityManager } = require('./VisibilityManager');
const { LightningSystem } = require('./LightningSystem');
const { BatterySpawner } = require('./BatterySpawner');
const { MAP_DATA } = require('../utils/MapData');

const HUNTER_COLORS = ['red', 'green', 'yellow', 'blue'];
const TICK_RATE = 20; // 20Hz server tick
const TICK_MS = 1000 / TICK_RATE;

// Lives by player count
const HUNTER_LIVES = { 2: 3, 3: 2, 4: 1 };

class GameRoom {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.players = new Map(); // socketId -> PlayerState
    this.gameState = 'lobby'; // lobby | playing | ended
    this.tickInterval = null;
    this.physics = new PhysicsEngine(MAP_DATA);
    this.visibility = new VisibilityManager();
    this.lightning = new LightningSystem(this);
    this.batterySpawner = new BatterySpawner(this);
    this.winner = null;
  }

  // ──────────────────────────────────────────────
  // Player Management
  // ──────────────────────────────────────────────

  addPlayer(socketId, name, isHost) {
    if (this.players.size >= 4) return { success: false, error: 'Room full' };

    const player = {
      id: socketId,
      name: name.slice(0, 20),
      isHost,
      ready: false,
      role: null,         // assigned at game start
      color: null,
      health: 100,
      lives: 0,
      downed: false,
      eliminated: false,
      position: { x: 0, y: 0, z: 0 },
      rotation: { y: 0 },
      velocity: { x: 0, z: 0 },
      flashlight: {
        active: false,
        battery: 100,
        angle: 0,        // horizontal aim angle (rad)
      },
      dashCooldown: 0,
      reviveProgress: 0,
      lastInput: null,
      lastProcessed: 0,
    };

    this.players.set(socketId, player);
    this._broadcastLobbyState();
    return { success: true, player };
  }

  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;
    this.players.delete(socketId);

    if (this.gameState === 'playing') {
      this._checkWinConditions();
      this._broadcastGameState();
    } else {
      this._broadcastLobbyState();
    }
  }

  setReady(socketId, ready) {
    const player = this.players.get(socketId);
    if (!player || this.gameState !== 'lobby') return;
    player.ready = ready;
    this._broadcastLobbyState();

    if (this.players.size >= 2 && [...this.players.values()].every(p => p.ready)) {
      this._startGame();
    }
  }

  // ──────────────────────────────────────────────
  // Game Start
  // ──────────────────────────────────────────────

  _startGame() {
    this.gameState = 'playing';
    const playerArray = [...this.players.values()];
    const count = playerArray.length;

    // Shuffle and assign roles
    const shuffled = [...playerArray].sort(() => Math.random() - 0.5);
    shuffled[0].role = 'ghost';
    shuffled[0].color = 'white';
    shuffled[0].health = 100;
    shuffled[0].position = { ...MAP_DATA.ghostSpawn };

    const availableColors = [...HUNTER_COLORS];
    const lives = HUNTER_LIVES[count];

    for (let i = 1; i < shuffled.length; i++) {
      const colorIdx = Math.floor(Math.random() * availableColors.length);
      shuffled[i].role = 'hunter';
      shuffled[i].color = availableColors.splice(colorIdx, 1)[0];
      shuffled[i].lives = lives;
      shuffled[i].health = 100;
      shuffled[i].position = { ...MAP_DATA.hunterSpawns[i - 1] };
    }

    this._broadcastToAll('game:start', {
      map: MAP_DATA.clientData,
      players: this._serializePlayers(),
    });

    this.lightning.start();
    this.batterySpawner.start();
    this._startGameLoop();
  }

  // ──────────────────────────────────────────────
  // Game Loop
  // ──────────────────────────────────────────────

  _startGameLoop() {
    let last = Date.now();
    this.tickInterval = setInterval(() => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      this._tick(dt);
    }, TICK_MS);
  }

  _tick(dt) {
    if (this.gameState !== 'playing') return;

    for (const [id, player] of this.players) {
      if (player.eliminated || player.downed) continue;
      this._processPlayerInput(player, dt);
      this._updateFlashlight(player, dt);
      if (player.dashCooldown > 0) player.dashCooldown -= dt;
    }

    this._processFlashlightDamage(dt);
    this._checkWinConditions();
    this._broadcastGameState();
  }

  // ──────────────────────────────────────────────
  // Input Processing
  // ──────────────────────────────────────────────

  receiveInput(socketId, input) {
    const player = this.players.get(socketId);
    if (!player || player.eliminated || player.downed) return;
    // Rate limit: only process inputs up to 60Hz
    const now = Date.now();
    if (now - player.lastProcessed < 14) return;
    player.lastProcessed = now;
    player.lastInput = input;
  }

  _processPlayerInput(player, dt) {
    const input = player.lastInput;
    if (!input) return;

    const speed = player.role === 'ghost' ? 4.5 : 3.5;
    let vx = 0, vz = 0;
    const angle = input.yaw || 0;

    if (input.w) { vx -= Math.sin(angle) * speed; vz -= Math.cos(angle) * speed; }
    if (input.s) { vx += Math.sin(angle) * speed; vz += Math.cos(angle) * speed; }
    if (input.a) { vx -= Math.cos(angle) * speed; vz += Math.sin(angle) * speed; }
    if (input.d) { vx += Math.cos(angle) * speed; vz -= Math.sin(angle) * speed; }

    // Dash (ghost only, shift key)
    if (player.role === 'ghost' && input.shift && player.dashCooldown <= 0) {
      vx *= 3.5;
      vz *= 3.5;
      player.dashCooldown = 6;
      player.dashTriggered = true; // signal visibility event
      this._onGhostDash(player);
    }

    const newPos = this.physics.moveEntity(player.position, vx * dt, vz * dt);
    player.position = newPos;
    player.rotation.y = angle;

    // Update flashlight angle for hunters
    if (player.role === 'hunter' && input.yaw !== undefined) {
      player.flashlight.angle = input.yaw;
    }

    // Flashlight toggle
    if (input.flashlightToggle !== undefined) {
      player.flashlight.active = input.flashlightToggle && player.flashlight.battery > 0;
    }

    // Attack (ghost, E key)
    if (player.role === 'ghost' && input.attack) {
      this._ghostAttack(player);
    }

    // Revive (hunter, E key)
    if (player.role === 'hunter' && input.revive) {
      this._tryRevive(player, dt);
    } else {
      player.reviveProgress = 0;
    }

    // Battery pickup
    this.batterySpawner.checkPickup(player);
  }

  // ──────────────────────────────────────────────
  // Flashlight
  // ──────────────────────────────────────────────

  _updateFlashlight(player, dt) {
    if (player.role !== 'hunter') return;
    if (player.flashlight.active) {
      player.flashlight.battery = Math.max(0, player.flashlight.battery - 5 * dt);
      if (player.flashlight.battery === 0) player.flashlight.active = false;
    }
  }

  _processFlashlightDamage(dt) {
    const ghost = [...this.players.values()].find(p => p.role === 'ghost');
    if (!ghost || ghost.eliminated) return;

    let totalDamage = 0;
    let ghostHit = false;

    for (const hunter of this.players.values()) {
      if (hunter.role !== 'hunter' || !hunter.flashlight.active || hunter.downed) continue;

      const result = this.visibility.flashlightHitsGhost(hunter, ghost);
      if (result.hit) {
        ghostHit = true;
        totalDamage += result.center ? 10 * dt : 5 * dt;
      }
    }

    if (ghostHit) {
      ghost.health = Math.max(0, ghost.health - totalDamage);
      ghost.litByFlashlight = true;
      ghost.litTimer = 2.0;
      this._broadcastToAll('ghost:hit', {
        ghostId: ghost.id,
        health: ghost.health,
        position: ghost.position,
      });
    } else if (ghost.litTimer > 0) {
      ghost.litTimer -= dt;
      if (ghost.litTimer <= 0) ghost.litByFlashlight = false;
    }
  }

  // ──────────────────────────────────────────────
  // Ghost Attack
  // ──────────────────────────────────────────────

  _ghostAttack(ghost) {
    const ATTACK_RANGE = 1.5;
    for (const hunter of this.players.values()) {
      if (hunter.role !== 'hunter' || hunter.eliminated) continue;

      const dx = hunter.position.x - ghost.position.x;
      const dz = hunter.position.z - ghost.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > ATTACK_RANGE) continue;

      // Check facing
      const toHunterAngle = Math.atan2(dx, dz);
      const facingAngle = ghost.rotation.y;
      const angleDiff = Math.abs(this._angleDiff(toHunterAngle, facingAngle));
      if (angleDiff > Math.PI / 3) continue; // 60° cone

      this._damageHunter(ghost, hunter);
      break; // one hit per attack press
    }
  }

  _damageHunter(ghost, hunter) {
    if (hunter.downed) return;

    hunter.lives--;
    this.io.to(hunter.id).emit('hunter:hit', { lives: hunter.lives });

    if (hunter.lives <= 0) {
      hunter.eliminated = true;
      this._broadcastToAll('hunter:eliminated', { hunterId: hunter.id });
    } else {
      hunter.downed = true;
      hunter.downedTimer = 0;
      this._broadcastToAll('hunter:downed', { hunterId: hunter.id });
    }
  }

  // ──────────────────────────────────────────────
  // Revive
  // ──────────────────────────────────────────────

  _tryRevive(reviverHunter, dt) {
    const REVIVE_RANGE = 2.0;
    const REVIVE_TIME = 3.0;

    for (const target of this.players.values()) {
      if (!target.downed || target.id === reviverHunter.id) continue;

      const dx = target.position.x - reviverHunter.position.x;
      const dz = target.position.z - reviverHunter.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > REVIVE_RANGE) continue;

      // Must be shining flashlight
      if (!reviverHunter.flashlight.active) continue;

      reviverHunter.reviveProgress += dt;
      this._broadcastToAll('revive:progress', {
        reviverId: reviverHunter.id,
        targetId: target.id,
        progress: reviverHunter.reviveProgress / REVIVE_TIME,
      });

      if (reviverHunter.reviveProgress >= REVIVE_TIME) {
        target.downed = false;
        reviverHunter.reviveProgress = 0;
        this._broadcastToAll('hunter:revived', { hunterId: target.id });
      }
      return;
    }
    reviverHunter.reviveProgress = 0;
  }

  // ──────────────────────────────────────────────
  // Ghost Dash Event
  // ──────────────────────────────────────────────

  _onGhostDash(ghost) {
    this._broadcastToAll('ghost:dash', {
      ghostId: ghost.id,
      position: ghost.position,
    });
    // Ghost visible on minimap for 1.5s
    ghost.minimapVisible = true;
    ghost.minimapTimer = 1.5;
  }

  // ──────────────────────────────────────────────
  // Win Conditions
  // ──────────────────────────────────────────────

  _checkWinConditions() {
    if (this.gameState !== 'playing') return;

    const ghost = [...this.players.values()].find(p => p.role === 'ghost');
    const hunters = [...this.players.values()].filter(p => p.role === 'hunter');

    if (!ghost || ghost.health <= 0) {
      this._endGame('hunters');
      return;
    }

    const allEliminated = hunters.length > 0 && hunters.every(h => h.eliminated);
    if (allEliminated) {
      this._endGame('ghost');
    }
  }

  _endGame(winner) {
    if (this.gameState === 'ended') return;
    this.gameState = 'ended';
    this.winner = winner;
    this.lightning.stop();
    this.batterySpawner.stop();
    clearInterval(this.tickInterval);
    this._broadcastToAll('game:end', { winner });
  }

  // ──────────────────────────────────────────────
  // State Broadcast
  // ──────────────────────────────────────────────

  _broadcastGameState() {
    // Build per-player visibility packets
    for (const [id, viewer] of this.players) {
      if (viewer.eliminated) continue;

      const packet = {
        players: [],
        batteries: this.batterySpawner.getVisibleBatteries(),
        tick: Date.now(),
      };

      for (const [, subject] of this.players) {
        const visible = this._isVisibleTo(viewer, subject);
        packet.players.push({
          id: subject.id,
          role: subject.role,
          color: subject.color,
          position: subject.position,
          rotation: subject.rotation,
          health: subject.role === 'ghost' ? subject.health : undefined,
          lives: subject.role === 'hunter' ? subject.lives : undefined,
          downed: subject.downed,
          eliminated: subject.eliminated,
          flashlight: subject.role === 'hunter' ? {
            active: subject.flashlight.active,
            battery: viewer.id === id ? subject.flashlight.battery : undefined,
            angle: subject.flashlight.angle,
          } : undefined,
          dashCooldown: viewer.id === id && subject.role === 'ghost' ? subject.dashCooldown : undefined,
          visible,
          minimapVisible: subject.role === 'ghost' ? this._isGhostOnMinimap(subject) : true,
          litByFlashlight: subject.litByFlashlight,
        });
      }

      this.io.to(id).emit('game:state', packet);
    }
  }

  _isVisibleTo(viewer, subject) {
    if (viewer.id === subject.id) return true;
    if (subject.role === 'hunter') return true; // hunters see each other

    // Ghost visibility rules
    if (viewer.role === 'ghost') return true; // ghost sees all
    if (subject.role === 'ghost') {
      // Hunters see ghost if: lightning active, flashlight hitting, or dash afterimage
      return subject.litByFlashlight || subject.lightningVisible || subject.minimapVisible;
    }
    return true;
  }

  _isGhostOnMinimap(ghost) {
    return ghost.litByFlashlight || ghost.lightningVisible || (ghost.minimapTimer > 0);
  }

  _broadcastLobbyState() {
    this._broadcastToAll('lobby:state', {
      code: this.code,
      players: [...this.players.values()].map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        ready: p.ready,
      })),
    });
  }

  _broadcastToAll(event, data) {
    this.io.to(this.code).emit(event, data);
  }

  _serializePlayers() {
    return [...this.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      color: p.color,
      lives: p.lives,
      health: p.health,
      position: p.position,
    }));
  }

  _angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  isFull() { return this.players.size >= 4; }
  isEmpty() { return this.players.size === 0; }

  destroy() {
    this.lightning.stop();
    this.batterySpawner.stop();
    clearInterval(this.tickInterval);
  }
}

module.exports = { GameRoom };
