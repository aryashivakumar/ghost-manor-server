/**
 * LightningSystem
 * Every 40–50 seconds, broadcasts a lightning event.
 * Lightning lasts 0.5 seconds server-side.
 * Ghost is made visible during lightning.
 */

class LightningSystem {
  constructor(room) {
    this.room = room;
    this.timeout = null;
    this.active = false;
  }

  start() {
    this._schedule();
  }

  stop() {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
  }

  _schedule() {
    const delay = (40 + Math.random() * 10) * 1000; // 40–50s
    this.timeout = setTimeout(() => this._trigger(), delay);
  }

  _trigger() {
    if (this.room.gameState !== 'playing') return;

    this.active = true;

    // Mark ghost as lightning-visible
    const ghost = [...this.room.players.values()].find(p => p.role === 'ghost');
    if (ghost) {
      ghost.lightningVisible = true;
      ghost.minimapVisible = true;
      ghost.minimapTimer = 1.5;
    }

    this.room.io.to(this.room.code).emit('lightning:strike', {
      duration: 500,
      timestamp: Date.now(),
    });

    // Clear after 0.5s
    setTimeout(() => {
      this.active = false;
      if (ghost) ghost.lightningVisible = false;
      this._schedule(); // schedule next
    }, 500);
  }
}

module.exports = { LightningSystem };
