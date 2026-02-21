/**
 * PhysicsEngine
 * Grid-based AABB collision detection.
 * Grid cell size: 1 unit.
 * Walls are stored as a Set of "x,z" strings.
 */

const PLAYER_RADIUS = 0.35;

class PhysicsEngine {
  constructor(mapData) {
    this.wallSet = new Set(mapData.walls.map(([x, z]) => `${x},${z}`));
    this.width = mapData.width;
    this.height = mapData.height;
  }

  /**
   * Move entity from current position by (dx, dz).
   * Performs separate X and Z axis resolution to allow sliding.
   */
  moveEntity(position, dx, dz) {
    let { x, y, z } = position;

    // Try X movement
    const nx = x + dx;
    if (!this._collidesAt(nx, z)) {
      x = nx;
    }

    // Try Z movement
    const nz = z + dz;
    if (!this._collidesAt(x, nz)) {
      z = nz;
    }

    return { x, y, z };
  }

  _collidesAt(x, z) {
    // Check all grid cells the player circle overlaps
    const minX = Math.floor(x - PLAYER_RADIUS);
    const maxX = Math.floor(x + PLAYER_RADIUS);
    const minZ = Math.floor(z - PLAYER_RADIUS);
    const maxZ = Math.floor(z + PLAYER_RADIUS);

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        if (this.wallSet.has(`${cx},${cz}`)) {
          // AABB vs circle check
          const nearX = Math.max(cx, Math.min(x, cx + 1));
          const nearZ = Math.max(cz, Math.min(z, cz + 1));
          const distSq = (x - nearX) ** 2 + (z - nearZ) ** 2;
          if (distSq < PLAYER_RADIUS * PLAYER_RADIUS) return true;
        }
      }
    }
    return false;
  }

  isWall(x, z) {
    return this.wallSet.has(`${Math.floor(x)},${Math.floor(z)}`);
  }

  /**
   * Raycast from origin in direction (dx, dz).
   * Returns hit distance or maxDist if no hit.
   */
  raycast(ox, oz, dx, dz, maxDist = 20) {
    const steps = Math.ceil(maxDist / 0.1);
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * maxDist;
      if (this.isWall(ox + dx * t, oz + dz * t)) {
        return t;
      }
    }
    return maxDist;
  }
}

module.exports = { PhysicsEngine };
