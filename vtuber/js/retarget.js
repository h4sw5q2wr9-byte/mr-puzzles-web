// Direction-based retargeting of MediaPipe 3D landmarks onto the VRM skeleton (arms, torso, hands).
//
// Instead of converting each landmark to Euler angles (Kalidokit), every bone is AIMED along the real
// limb direction, measured in metres from MediaPipe's world landmarks:
//   * upper arm: aimed at the elbow, twisted so the elbow bends in the real shoulder-elbow-wrist plane
//   * forearm: bends around that elbow hinge only (no impossible sideways elbows)
//   * torso: chest frame from the shoulder line and the hips->shoulders line
//   * hand: palm frame (wrist, index / middle / pinky knuckles) -> true wrist rotation incl. twist
//   * fingers: every joint aimed along its bone; curl / splay limited to what a hand can do
// Landmarks are filtered (One-Euro per point, impossible jumps need confirmation) and mirrored: the
// person's LEFT drives the avatar's RIGHT, like a mirror. Depth from one camera is noisy, so it is
// damped (opts.depth): this is what made arms "go forward" before.
import * as THREE from 'three';
import { VRMSchema } from '@pixiv/three-vrm';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const alphaHz = (fc, dt) => 1 - Math.exp(-2 * Math.PI * fc * Math.max(dt, 1 / 240));
const V = () => new THREE.Vector3(), Q = () => new THREE.Quaternion();
const SIDES = ['Right', 'Left'];
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const JOINTS = ['Proximal', 'Intermediate', 'Distal'];
// MediaPipe hand landmark chains per finger (base -> tip)
const HAND_CHAIN = { Thumb: [1, 2, 3, 4], Index: [5, 6, 7, 8], Middle: [9, 10, 11, 12], Ring: [13, 14, 15, 16], Little: [17, 18, 19, 20] };
// pose landmarks per AVATAR side (mirror: the person's left = indices 11/13/15 drive the avatar's right)
const POSE_ARM = { Right: { sh: 11, el: 13, wr: 15, hip: 23 }, Left: { sh: 12, el: 14, wr: 16, hip: 24 } };

/** One-Euro filter for a 3D point; a jump faster than maxSpeed (m/s) needs a second frame to confirm */
class PointFilter {
  constructor(minCut, beta, maxSpeed = 6) { this.minCut = minCut; this.beta = beta; this.maxSpeed = maxSpeed; this.x = null; this.dx = V(); this.raw = null; this.pend = null; this.pendN = 0; this.age = 0; }
  step(p, dt, conf = 1) {
    if (!this.x) { this.x = p.clone(); this.raw = p.clone(); return this.x; }
    this.age += dt;
    const lim = Math.max(0.06, this.maxSpeed * dt);
    if (this.age < 0.3 && p.distanceTo(this.raw) > lim) {
      if (this.pend && this.pend.distanceTo(p) < lim) this.pendN++; else this.pendN = 1;
      (this.pend || (this.pend = V())).copy(p);
      if (this.pendN < 2) return this.x;               // wait for confirmation
    }
    this.pendN = 0; this.age = 0; this.raw.copy(p);
    const d = _t.copy(p).sub(this.x).divideScalar(Math.max(dt, 1 / 240));
    this.dx.lerp(d, alphaHz(1.2, dt));
    const a = alphaHz(this.minCut + this.beta * this.dx.length(), dt) * clamp(conf, 0.05, 1);
    this.x.lerp(p, a);
    return this.x;
  }
  reset() { this.x = null; }
}
const _t = V(), _a = V(), _b = V(), _c = V(), _q = Q(), _q2 = Q(), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();

/** rotation that maps the orthonormal frame (x0,y0,z0) onto (x1,y1,z1) */
function frameRotation(x0, y0, z0, x1, y1, z1, out) {
  _m.makeBasis(x1, y1, z1); _m2.makeBasis(x0, y0, z0).transpose();
  return out.setFromRotationMatrix(_m.multiply(_m2));
}
/** orthonormal frame from a primary axis and a hint (Gram-Schmidt): returns [x, y, z] with x = a */
function frame(a, hint) {
  const x = a.clone().normalize();
  const y = hint.clone().sub(x.clone().multiplyScalar(hint.dot(x)));
  if (y.lengthSq() < 1e-8) y.set(0, 1, 0).sub(x.clone().multiplyScalar(x.y));
  y.normalize();
  return [x, y, x.clone().cross(y)];
}

export class Retarget {
  constructor(vrm) {
    this.vrm = vrm;
    this.bone = (n) => vrm.humanoid.getBoneNode(VRMSchema.HumanoidBoneName[n]);
    vrm.scene.updateMatrixWorld(true);
    // rest pose (VRM T-pose, palms down): world rotation / position of every bone we drive
    this.rest = {};
    const names = ['Hips', 'Spine', 'Chest', 'Neck', 'Head'];
    for (const s of SIDES) {
      names.push(s + 'Shoulder', s + 'UpperArm', s + 'LowerArm', s + 'Hand');
      for (const f of FINGERS) for (const j of JOINTS) names.push(s + f + j);
    }
    for (const n of names) {
      const b = this.bone(n); if (!b) continue;
      this.rest[n] = { b, local: b.quaternion.clone(), world: b.getWorldQuaternion(Q()), pos: b.getWorldPosition(V()) };
    }
    const dir = (a, b) => (this.rest[a] && this.rest[b] ? this.rest[b].pos.clone().sub(this.rest[a].pos).normalize() : null);
    this.restDir = {};
    for (const s of SIDES) {
      this.restDir[s + 'UpperArm'] = dir(s + 'UpperArm', s + 'LowerArm');
      this.restDir[s + 'LowerArm'] = dir(s + 'LowerArm', s + 'Hand');
      for (const f of FINGERS) {
        const p = s + f + 'Proximal', i = s + f + 'Intermediate', d = s + f + 'Distal';
        this.restDir[p] = dir(p, i); this.restDir[i] = dir(i, d); this.restDir[d] = this.restDir[i];
      }
      // rest palm frame
      const fwd = dir(s + 'Hand', s + 'MiddleProximal'), side = dir(s + 'LittleProximal', s + 'IndexProximal');
      if (fwd && side) this.restDir[s + 'Palm'] = frame(fwd, side);
    }
    // the model is turned to face the camera (+Z); elbows bend toward the front
    this.front = new THREE.Vector3(0, 0, 1);
    this.filters = {};
    this.handFilters = { Left: {}, Right: {} };
    this.bendHint = { Left: null, Right: null };
    this.twist = { Left: null, Right: null };
  }

  /** MediaPipe (x right, y down, z away; metres) -> scene, mirrored, depth damped */
  toScene(p, depth, out = V()) { return out.set(-p.x, -p.y, -(p.z || 0) * depth); }

  /** set a bone's WORLD rotation (via its parent's current world rotation), smoothed by `a` */
  setWorld(name, qWorld, a = 1) {
    const r = this.rest[name]; if (!r) return;
    const parent = r.b.parent;
    parent.updateWorldMatrix(true, false);
    parent.getWorldQuaternion(_q2);
    const local = _q2.invert().multiply(qWorld);
    r.b.quaternion.slerp(local, a);
    r.b.updateMatrixWorld(true);
  }
  worldOf(name, out = Q()) { const b = this.rest[name].b; b.updateWorldMatrix(true, false); return b.getWorldQuaternion(out); }

  /**
   * arms + torso from pose world landmarks
   * @param wl     33 world landmarks (MediaPipe, metres)
   * @param vis    visibility per landmark index (0..1)
   * @param opts   {dt, depth (0..1), torso (0..1), handsSeen: {Left, Right}}
   */
  /**
   * Arm points by "2D + bone length" lifting: across / up from the precise image landmarks (scaled to
   * metres with the torso), depth from the segment's known length (a forearm pointing at the camera
   * is short in the picture -> it must point toward the camera). MediaPipe's own 3D only decides in
   * front / behind. Falls back to MediaPipe 3D when the 2D points are unreliable.
   */
  liftArms(wl, lm, vis, aspect, P, dt) {
    // metres per image unit from torso segments (both are projections of the same 3D segments)
    let num = 0, den = 0;
    for (const [a, b] of [[11, 12], [11, 23], [12, 24]]) {
      const wv = Math.min(vis(a), vis(b)); if (wv < 0.5) continue;
      num += Math.hypot(wl[b].x - wl[a].x, wl[b].y - wl[a].y) * wv;
      den += Math.hypot((lm[b].x - lm[a].x) * aspect, lm[b].y - lm[a].y) * wv;
    }
    if (den > 1e-3) { const k = num / den; this.scale = this.scale ? this.scale + (k - this.scale) * alphaHz(0.5, dt) : k; }
    if (!this.scale) return;
    this.segLen = this.segLen || {};
    for (const s of SIDES) {
      const ix = POSE_ARM[s];
      let prev = P[ix.sh];
      for (const [a, b] of [[ix.sh, ix.el], [ix.el, ix.wr]]) {
        const key = a + '-' + b;
        const w3 = Math.hypot(wl[b].x - wl[a].x, wl[b].y - wl[a].y, wl[b].z - wl[a].z);
        // the person's segment length: a slow average of MediaPipe's 3D lengths (fairly constant)
        this.segLen[key] = this.segLen[key] ? this.segLen[key] + (w3 - this.segLen[key]) * alphaHz(0.3, dt) : w3;
        const dx = -(lm[b].x - lm[a].x) * aspect * this.scale, dy = -(lm[b].y - lm[a].y) * this.scale;
        const d2 = Math.hypot(dx, dy);
        // ... and the longest it has looked in the picture lately (same scale as dx/dy, decays slowly)
        this.seg2D = this.seg2D || {};
        this.seg2D[key] = Math.max(d2, (this.seg2D[key] || 0) * (1 - 0.03 * dt));
        const L = Math.max(d2, 0.5 * this.segLen[key] + 0.5 * Math.max(this.seg2D[key], this.segLen[key] * 0.8));
        const wdz = -(wl[b].z - wl[a].z);                        // MediaPipe: + = toward the camera (scene +Z)
        // lifted depth only where the segment is clearly shortened in the picture; otherwise MediaPipe's
        const fore = smoothstep(0.12, 0.4, 1 - d2 / L);
        const dzL = Math.sqrt(Math.max(0, L * L - d2 * d2));
        // in front / behind: only switch on clear evidence (the classic one-camera depth flip)
        this.depthSign = this.depthSign || {};
        let sgn = this.depthSign[key] || 1;                      // unsure -> in front (arms rarely go behind)
        if (wdz > 0.07) sgn = 1; else if (wdz < -0.09) sgn = -1;
        this.depthSign[key] = sgn;
        const dz = wdz + (sgn * dzL - wdz) * fore;
        const trust = smoothstep(0.4, 0.8, Math.min(vis(a), vis(b)));
        const lifted = _t.set(dx, dy, dz);
        const mp = _c.set(-(wl[b].x - wl[a].x), -(wl[b].y - wl[a].y), wdz);
        const seg = mp.lerp(lifted, trust);
        const pt = prev.clone().add(seg);
        P[b] = this.liftFilters[b].step(pt, dt, 1);
        prev = P[b];
      }
    }
  }

  solveBody(wl, vis, { dt = 1 / 30, depth = 0.55, torso = 1, follow = 0.75, handsSeen = {}, skip = {}, lm = null, aspect = 4 / 3, lift = true } = {}) {
    const P = {};
    const f = (i, conf) => {
      const flt = this.filters[i] || (this.filters[i] = new PointFilter(1.0, 1.6));
      return (P[i] = flt.step(this.toScene(wl[i], depth, _a), dt, conf));
    };
    for (const i of [11, 12, 13, 14, 15, 16, 23, 24]) f(i, smoothstep(0.2, 0.7, vis(i)));
    if (lift && lm) {
      this.liftFilters = this.liftFilters || Object.fromEntries([13, 14, 15, 16].map((i) => [i, new PointFilter(1.0, 1.6)]));
      this.liftArms(wl, lm, vis, aspect, P, dt);
    }
    const a = alphaHz(9, dt) * follow + (1 - follow) * alphaHz(4, dt);

    // ---- torso: chest frame from the shoulder line (avatar right -> left) and hips -> shoulders
    if (torso > 0 && this.rest.Chest && this.rest.Spine) {
      const across = _b.copy(P[12]).sub(P[11]);                             // avatar's right -> left shoulder
      const up = _c.copy(P[11]).add(P[12]).multiplyScalar(0.5).sub(_t.copy(P[23]).add(P[24]).multiplyScalar(0.5));
      if (across.lengthSq() > 1e-4 && up.lengthSq() > 1e-4) {
        const [fx, fy, fz] = frame(across, up);                           // rest: +X across, +Y up, +Z front
        let R = frameRotation(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), fx, fy, fz, Q());
        // keep it human: limit to ~50 deg yaw, 25 deg lean / roll, and apply only part of it
        const e = new THREE.Euler().setFromQuaternion(R, 'YXZ');
        e.set(clamp(e.x, -0.45, 0.45) * 0.7, clamp(e.y, -0.9, 0.9) * 0.8, clamp(e.z, -0.45, 0.45) * 0.8, 'YXZ');
        R = Q().setFromEuler(e);
        const half = Q().slerp(R, 0.5);
        // the torso follows only as far as both shoulders are really seen
        const tc = smoothstep(0.5, 0.85, Math.min(vis(11), vis(12)));
        this.setWorld('Spine', half.clone().multiply(this.rest.Spine.world), a * torso * tc);
        this.setWorld('Chest', R.clone().multiply(this.rest.Chest.world), a * torso * tc);
      }
    }

    // ---- arms
    const out = {};
    for (const s of SIDES) {
      if (skip[s]) continue;
      const ix = POSE_ARM[s];
      const sh = P[ix.sh], el = P[ix.el], wr = P[ix.wr];
      // trust: the upper arm needs the elbow; the forearm the wrist (a hand the hand tracker sees counts)
      const seen = handsSeen[s] ? 0.7 : 0;
      const cU = Math.max(seen, smoothstep(0.25, 0.65, vis(ix.el)));
      const cL = Math.max(seen, Math.min(cU, smoothstep(0.25, 0.65, vis(ix.wr))));
      out[s] = { cU, cL };
      const u = _a.copy(el).sub(sh); const lu = u.length(); if (lu < 1e-4) continue; u.divideScalar(lu);
      const w = _b.copy(wr).sub(el); const lw = w.length(); if (lw < 1e-4) continue; w.divideScalar(lw);
      // bend direction (the forearm's direction across the upper arm); undefined when the arm is straight
      const perp = _c.copy(w).sub(_t.copy(u).multiplyScalar(u.dot(w)));
      const bendAmt = perp.length();
      // default bend: the rest bend direction (front) carried along by the shortest swing of the upper arm
      const swing = Q().setFromUnitVectors(this.restDir[s + 'UpperArm'], u);
      const fDef = this.front.clone().applyQuaternion(swing);
      fDef.sub(u.clone().multiplyScalar(fDef.dot(u))).normalize();
      // the upper arm's twist = the angle of the bend plane around the arm, kept as one tracked value:
      // within what a shoulder can do (+-110 deg), turning at most ~10 rad/s, and held while the arm
      // is straight (then the bend plane is undefined and would spin)
      const side2 = u.clone().cross(fDef);
      let phiMeas = bendAmt > 1e-4 ? Math.atan2(perp.dot(side2), perp.dot(fDef)) : 0;
      const k = smoothstep(0.12, 0.45, bendAmt);
      const prev = this.twist[s] ?? phiMeas * k;
      let dphi = phiMeas - prev; dphi = Math.atan2(Math.sin(dphi), Math.cos(dphi));
      const maxStep = 10 * dt;
      let phi = prev + clamp(dphi * k, -maxStep, maxStep);
      phi = clamp(phi, -1.9, 1.9);
      this.twist[s] = phi;
      const fb = fDef.clone().multiplyScalar(Math.cos(phi)).add(side2.clone().multiplyScalar(Math.sin(phi))).normalize();
      // upper arm: rest frame (dir, front, hinge) -> measured (u, fb, hinge)
      const d0 = this.restDir[s + 'UpperArm'];
      const f0 = this.front.clone().sub(d0.clone().multiplyScalar(this.front.dot(d0))).normalize();
      const n0 = d0.clone().cross(f0), n1 = u.clone().cross(fb);
      const RU = frameRotation(d0, f0, n0, u, fb, n1, Q());
      // shoulder: a little shrug when the arm goes above the shoulder line
      if (this.rest[s + 'Shoulder']) {
        const lift = smoothstep(0.1, 0.9, u.y) * 0.35;
        this.setWorld(s + 'Shoulder', Q().slerp(Q().setFromUnitVectors(d0, u), lift * 0.4).multiply(this.rest[s + 'Shoulder'].world), a);
      }
      this.setWorld(s + 'UpperArm', RU.clone().multiply(this.rest[s + 'UpperArm'].world), a * cU);
      // forearm: bend around the hinge by the real elbow angle (0..150 deg)
      const theta = clamp(Math.acos(clamp(u.dot(w), -1, 1)), 0, 2.6);
      const hinge = n1.clone().normalize();
      const qL = Q().setFromAxisAngle(hinge, theta).multiply(RU).multiply(this.rest[s + 'LowerArm'].world);
      this.setWorld(s + 'LowerArm', qL, a * cL);
      out[s].theta = theta; out[s].u = u.clone(); out[s].w = w.clone();
    }
    return out;
  }

  /** hand + fingers from hand world landmarks (21 points, metres) for the avatar side s */
  solveHand(s, hw, { dt = 1 / 30, follow = 0.75, weight = 1 } = {}) {
    const rp = this.restDir[s + 'Palm']; if (!rp || !this.rest[s + 'Hand']) return;
    const F = this.handFilters[s];
    const H = [];
    for (let i = 0; i < 21; i++) {
      const flt = F[i] || (F[i] = new PointFilter(1.6, 4, 3));
      H[i] = flt.step(this.toScene(hw[i], 1, _a), dt, 1).clone();   // hand depth is reliable at this scale
    }
    const a = (alphaHz(10, dt) * follow + (1 - follow) * alphaHz(5, dt)) * weight;
    // palm frame: wrist -> middle knuckle, pinky -> index knuckle
    const fwd = H[9].clone().sub(H[0]), side = H[5].clone().sub(H[17]);
    if (fwd.lengthSq() < 1e-8 || side.lengthSq() < 1e-8) return;
    const [x1, y1, z1] = frame(fwd, side);
    const R = frameRotation(rp[0], rp[1], rp[2], x1, y1, z1, Q());
    this.setWorld(s + 'Hand', R.clone().multiply(this.rest[s + 'Hand'].world), a);
    // palm normal (the side fingers curl toward): rest palms face down (-Y) in a VRM T-pose
    const palmN = new THREE.Vector3(0, -1, 0).applyQuaternion(R);
    const sideAx = y1.clone();
    for (const f of FINGERS) {
      const ch = HAND_CHAIN[f];
      for (let j = 0; j < 3; j++) {
        const name = s + f + JOINTS[j];
        const r = this.rest[name]; if (!r || !this.restDir[name]) continue;
        let d = H[ch[j + 1]].clone().sub(H[ch[j]]);
        if (d.lengthSq() < 1e-10) continue;
        d.normalize();
        // where the bone would point if it kept its rest pose relative to its (already posed) parent
        const parentW = r.b.parent.getWorldQuaternion(Q());
        const restW = parentW.clone().multiply(r.local);
        const d0 = this.restDir[name].clone().applyQuaternion(r.world.clone().invert()).applyQuaternion(restW).normalize();
        if (f !== 'Thumb') {
          // decompose into curl (toward the palm) and splay (sideways); limit both
          const curlAx = palmN.clone().sub(d0.clone().multiplyScalar(palmN.dot(d0))).normalize();
          const splayAx = d0.clone().cross(curlAx).normalize();
          let curl = Math.atan2(d.dot(curlAx), d.dot(d0));
          let splay = Math.asin(clamp(d.dot(splayAx), -1, 1));
          curl = clamp(curl, j === 0 ? -0.35 : -0.1, j === 0 ? 1.6 : 1.9);
          splay = j === 0 ? clamp(splay, -0.35, 0.35) : 0;
          d = d0.clone().multiplyScalar(Math.cos(curl) * Math.cos(splay)).add(curlAx.clone().multiplyScalar(Math.sin(curl) * Math.cos(splay))).add(splayAx.clone().multiplyScalar(Math.sin(splay))).normalize();
        }
        const swing = Q().setFromUnitVectors(d0, d);
        this.setWorld(name, swing.multiply(restW), a);
      }
    }
    void sideAx;
  }

  /** let a hand that is not tracked follow the forearm with a soft natural curl */
  relaxHand(s, dt) {
    const k = alphaHz(1.5, dt);
    if (this.rest[s + 'Hand']) this.rest[s + 'Hand'].b.quaternion.slerp(this.rest[s + 'Hand'].local, k);
    for (const f of FINGERS) for (const j of JOINTS) {
      const r = this.rest[s + f + j]; if (!r) continue;
      _q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (f === 'Thumb' ? 0 : 0.25) * (s === 'Right' ? -1 : 1)).premultiply(r.local);
      r.b.quaternion.slerp(f === 'Thumb' ? r.local : _q, k);
    }
    for (const i in this.handFilters[s]) this.handFilters[s][i].reset();
  }
  resetFilters() { for (const k in this.filters) this.filters[k].reset(); this.twist = { Left: null, Right: null }; }
}
