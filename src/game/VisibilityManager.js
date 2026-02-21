/**
 * VisibilityManager
 * Server-side flashlight cone vs ghost position check.
 * FOV: 45 degrees half-angle (90 degree total cone).
 * Range: 10 units.
 */

const FLASHLIGHT_FOV = Math.PI / 4; // 45° half-angle
const FLASHLIGHT_RANGE = 10;

class VisibilityManager {
  /**
   * Returns { hit: bool, center: bool }
   * center = true if ghost is in inner 15° cone (full damage)
   */
  flashlightHitsGhost(hunter, ghost) {
    const dx = ghost.position.x - hunter.position.x;
    const dz = ghost.position.z - hunter.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist > FLASHLIGHT_RANGE) return { hit: false };

    // Angle of ghost relative to hunter's facing
    const ghostAngle = Math.atan2(dx, dz);
    const facingAngle = hunter.flashlight.angle; // yaw
    const diff = Math.abs(this._angleDiff(ghostAngle, facingAngle));

    if (diff > FLASHLIGHT_FOV) return { hit: false };

    const center = diff < Math.PI / 12; // inner 15°
    return { hit: true, center };
  }

  _angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }
}

module.exports = { VisibilityManager };
