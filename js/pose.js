// Head pose smoothing (One-Euro filter on position + rotation) and selfie-mirror handling.
import * as THREE from '../vendor/three/three.module.js';

class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1.0) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.x = null; this.dx = 0; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  reset() { this.x = null; this.dx = 0; }
  filter(v, dt) {
    if (this.x === null) { this.x = v; this.dx = 0; return v; }
    const d = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (d - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

export class PoseFilter {
  constructor() {
    // position in cm: calm when still, responsive when moving.  rotation components are unit-less.
    this.p = [0, 1, 2].map(() => new OneEuro(1.4, 0.35));
    this.q = [0, 1, 2, 3].map(() => new OneEuro(2.0, 6.0));
    this.s = new OneEuro(0.6, 0.0);
    this.m = new THREE.Matrix4(); this.pos = new THREE.Vector3(); this.quat = new THREE.Quaternion(); this.scl = new THREE.Vector3();
    this.out = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: 1 };
    this.prevQ = new THREE.Quaternion();
  }
  reset() { this.p.forEach(f => f.reset()); this.q.forEach(f => f.reset()); this.s.reset(); }

  /** @param {ArrayLike<number>} data column-major 4x4 from MediaPipe  @param {boolean} mirror selfie view */
  update(data, dt, mirror) {
    this.m.fromArray(data);
    this.m.decompose(this.pos, this.quat, this.scl);
    if (mirror) {                    // F * M * F with F = diag(-1,1,1): the head keeps its handedness, the motion is mirrored
      this.pos.x = -this.pos.x;
      this.quat.set(this.quat.x, -this.quat.y, -this.quat.z, this.quat.w);
    }
    if (this.q[0].x !== null && this.prevQ.dot(this.quat) < 0) this.quat.set(-this.quat.x, -this.quat.y, -this.quat.z, -this.quat.w);  // same hemisphere
    this.prevQ.copy(this.quat);
    const o = this.out;
    o.position.set(this.p[0].filter(this.pos.x, dt), this.p[1].filter(this.pos.y, dt), this.p[2].filter(this.pos.z, dt));
    o.quaternion.set(this.q[0].filter(this.quat.x, dt), this.q[1].filter(this.quat.y, dt), this.q[2].filter(this.quat.z, dt), this.q[3].filter(this.quat.w, dt)).normalize();
    o.scale = this.s.filter(THREE.MathUtils.clamp((this.scl.x + this.scl.y + this.scl.z) / 3, 0.75, 1.3), dt);
    return o;
  }
}
