/**
 * BatterySpawner
 * Spawns battery packs at random valid positions in the maze.
 * Max 4 batteries active at once.
 * Batteries despawn after 10 seconds if not picked up.
 * Picking up refills flashlight to 100%.
 */

const { MAP_DATA } = require('../utils/MapData');

const MAX_BATTERIES = 4;
const SPAWN_INTERVAL = 8000; // ms
const DESPAWN_TIME = 10000; // ms
const PICKUP_RANGE = 1.0;

let batteryIdCounter = 0;

class BatterySpawner {
  constructor(room) {
    this.room = room;
    this.batteries = new Map(); // id -> battery
    this.spawnInterval = null;
  }

  start() {
    this.spawnInterval = setInterval(() => this._maybeSpawn(), SPAWN_INTERVAL);
    // Spawn initial batteries
    for (let i = 0; i < 3; i++) this._spawnOne();
  }

  stop() {
    clearInterval(this.spawnInterval);
    this.batteries.clear();
  }

  _maybeSpawn() {
    if (this.batteries.size >= MAX_BATTERIES) return;
    this._spawnOne();
  }

  _spawnOne() {
    const pos = this._randomOpenPosition();
    if (!pos) return;

    const id = `bat_${batteryIdCounter++}`;
    const battery = {
      id,
      position: pos,
      spawnedAt: Date.now(),
    };

    this.batteries.set(id, battery);
    this.room.io.to(this.room.code).emit('battery:spawn', { battery });

    // Auto despawn
    battery._timeout = setTimeout(() => {
      if (this.batteries.has(id)) {
        this.batteries.delete(id);
        this.room.io.to(this.room.code).emit('battery:despawn', { id });
      }
    }, DESPAWN_TIME);
  }

  checkPickup(player) {
    if (player.role !== 'hunter') return;

    for (const [id, battery] of this.batteries) {
      const dx = battery.position.x - player.position.x;
      const dz = battery.position.z - player.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < PICKUP_RANGE) {
        clearTimeout(battery._timeout);
        this.batteries.delete(id);
        player.flashlight.battery = 100;
        this.room.io.to(this.room.code).emit('battery:despawn', { id });
        this.room.io.to(player.id).emit('battery:pickup', { battery: 100 });
        return;
      }
    }
  }

  getVisibleBatteries() {
    return [...this.batteries.values()].map(b => ({
      id: b.id,
      position: b.position,
    }));
  }

  _randomOpenPosition() {
    const openCells = MAP_DATA.openCells;
    if (!openCells || openCells.length === 0) return null;
    const attempts = 20;
    for (let i = 0; i < attempts; i++) {
      const cell = openCells[Math.floor(Math.random() * openCells.length)];
      return { x: cell[0] + 0.5, y: 0, z: cell[1] + 0.5 };
    }
    return null;
  }
}

module.exports = { BatterySpawner };
