// Applies Kalidokit solutions (the same solver Kalidoface 3D uses) to the VRM humanoid.
//  * adaptive smoothing per bone (One-Euro style, in rotation space): still -> heavy smoothing, no
//    shake; fast moves -> follows quickly
//  * trust per arm segment from MediaPipe's landmark visibility: a hidden elbow / wrist is followed
//    less, single-frame jumps from unreliable landmarks are ignored, and an arm that stays hidden eases
//    into a relaxed pose instead of flailing
//  * detected hands fade in / out instead of snapping; per-limb tracking-loss recovery; foot grounding
import * as THREE from 'three';
import * as Kalidokit from 'kalidokit';
import { VRMSchema } from '@pixiv/three-vrm';
import { Retarget } from './retarget.js?v=20261114.2020-4522d59';

const R = Kalidokit.Utils.RestingDefault.Pose;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// lerp factor tuned at 60 fps -> same feel at any frame rate
const rate = (k, dt) => 1 - Math.pow(1 - k, Math.max(dt, 1 / 240) * 60);
// low-pass factor for a cutoff frequency (Hz)
const alphaHz = (fc, dt) => 1 - Math.exp(-2 * Math.PI * fc * Math.max(dt, 1 / 240));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// smoothing profiles: minCut = cutoff when still (Hz), beta = extra cutoff per rad/s of movement
const PROF = {
  torso: { minCut: 0.9, beta: 0.5 },
  arm: { minCut: 1.3, beta: 0.55 },
  hand: { minCut: 0.9, beta: 0.35 },
  finger: { minCut: 2.0, beta: 0.5 },
  leg: { minCut: 1.2, beta: 0.9 },
};

const IDLE = {
  RightUpperArm: { x: 0, y: 0, z: -1.25 }, LeftUpperArm: { x: 0, y: 0, z: 1.25 },
  RightLowerArm: { x: 0, y: 0, z: 0 }, LeftLowerArm: { x: 0, y: 0, z: 0 },
  RightHand: { x: 0, y: 0, z: 0 }, LeftHand: { x: 0, y: 0, z: 0 },
  RightUpperLeg: { x: 0, y: 0, z: 0 }, LeftUpperLeg: { x: 0, y: 0, z: 0 },
  RightLowerLeg: { x: 0, y: 0, z: 0 }, LeftLowerLeg: { x: 0, y: 0, z: 0 },
  Spine: { x: 0, y: 0, z: 0 }, Chest: { x: 0, y: 0, z: 0 }, Hips: { x: 0, y: 0, z: 0 },
};
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const JOINTS = ['Proximal', 'Intermediate', 'Distal'];
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _v = new THREE.Vector3();

export class BodyRig {
  constructor(vrm) {
    this.vrm = vrm;
    this.bone = (n) => vrm.humanoid.getBoneNode(VRMSchema.HumanoidBoneName[n]);
    const hips = this.bone('Hips');
    this.hipsRest = hips.position.clone();
    this.lastPoseTime = -1e9; this.lastHand = { Left: -1e9, Right: -1e9 };
    this.footAnchor = null;
    this.toesRestY = Math.min(this.worldY('LeftFoot'), this.worldY('RightFoot'));
    this.groundOffset = 0;
    this.filt = {};                      // per bone: smoothed angular speed
    this.handW = { Left: 0, Right: 0 };   // how much the hand tracker drives each wrist / fingers
    this.armHidden = { Left: 0, Right: 0 };   // seconds an arm has been (mostly) invisible
    // 3D retargeting of arms / torso / hands (captures the rest pose now, before anything moves)
    this.rt = new Retarget(vrm);
    this.opts = { solver: 'aim', depth: 0.9, follow: 0.75, lift: true };
  }
  worldY(n) { const b = this.bone(n); b.updateWorldMatrix(true, false); return b.getWorldPosition(_v).y; }

  rot(name, r, damp = 1, k = 0.3, dt = 1 / 60) {
    const b = this.bone(name); if (!b || !r) return;
    _e.set((r.x || 0) * damp, (r.y || 0) * damp, (r.z || 0) * damp, r.rotationOrder || 'XYZ');
    _q.setFromEuler(_e);
    b.quaternion.slerp(_q, rate(k, dt));
  }

  /** live tracking: move the bone toward r with adaptive smoothing; conf (0..1) = how much to trust r */
  track(name, r, damp, dt, prof, conf = 1) {
    const b = this.bone(name); if (!b || !r) return;
    _e.set((r.x || 0) * damp, (r.y || 0) * damp, (r.z || 0) * damp, r.rotationOrder || 'XYZ');
    _q.setFromEuler(_e);
    const st = this.filt[name] || (this.filt[name] = { vs: 0, pending: null, pendingN: 0, lastRaw: null, age: 0 });
    const jump = b.quaternion.angleTo(_q);
    // the TARGET jumping faster than a real arm can move (~10 rad/s) is only followed once the next
    // frames confirm it (bigger jump -> more frames): genuine moves persist, tracking glitches flip back.
    // Compared with the last accepted target (not the smoothed bone, whose lag is not a glitch).
    const limit = Math.max(0.35, 10 * dt);
    st.age += dt;
    if (st.lastRaw && st.age < 0.3) {
      const rawJump = st.lastRaw.angleTo(_q);
      if (rawJump > limit) {
        // consistent with the previous unconfirmed target (moving at a plausible speed)? count it
        if (st.pending && st.pending.angleTo(_q) < limit) st.pendingN++; else st.pendingN = 1;
        (st.pending || (st.pending = new THREE.Quaternion())).copy(_q);
        if (st.pendingN <= Math.min(2, Math.ceil(rawJump / limit) - 1)) return;
      }
    }
    st.pending = null; st.age = 0;
    (st.lastRaw || (st.lastRaw = new THREE.Quaternion())).copy(_q);
    st.vs += (jump / Math.max(dt, 1 / 240) - st.vs) * alphaHz(3, dt);
    const a = alphaHz(prof.minCut + prof.beta * st.vs, dt) * conf;
    b.quaternion.slerp(_q, a);
  }

  /** head rotation (Kalidokit); the face's left/right is set separately by the "Invert face" setting */
  applyHead(face, dt, hipsYaw = 0) {
    if (!face) return;
    const h = face.head;
    const t = { x: clamp(h.x, -0.8, 0.8), y: clamp(h.y - hipsYaw, -0.9, 0.9), z: clamp(h.z, -0.6, 0.6) };
    // the face gives the head's turn relative to the CAMERA; the chest may already be turned (body
    // tracking), so only the rest goes into neck + head (otherwise a turned torso doubles the head turn)
    _e.set(t.x, t.y, t.z, 'XYZ'); const qF = new THREE.Quaternion().setFromEuler(_e);
    const chest = this.bone('Chest') || this.bone('Spine'), rest = this.rt && this.rt.rest[chest === this.bone('Chest') ? 'Chest' : 'Spine'];
    if (chest && rest) {
      chest.updateWorldMatrix(true, false);
      const qC = chest.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rest.world);
      qF.premultiply(qC);
    }
    const k = rate(0.35, dt);
    this.bone('Neck')?.quaternion.slerp(new THREE.Quaternion().slerp(qF, 0.55), k);
    this.bone('Head')?.quaternion.slerp(new THREE.Quaternion().slerp(qF, 0.45), k);
  }

  relaxHead(dt) { this.rot('Neck', { x: 0, y: 0, z: 0 }, 1, 0.05, dt); this.rot('Head', { x: 0, y: 0, z: 0 }, 1, 0.05, dt); }

  /**
   * @param pose   Kalidokit.Pose.solve output or null (lost)
   * @param hands  {Left: Kalidokit.Hand.solve output|null, Right: ...} keyed by AVATAR side
   * @param opts   {legs:boolean, now:number(seconds), dt}
   */
  applyBody(pose, hands, { legs = false, now = 0, dt = 1 / 60, moveRoot = true } = {}) {
    const lost = !pose;
    if (!lost) this.lastPoseTime = now;
    const sinceLost = now - this.lastPoseTime;
    if (lost) {
      // tracking loss: hold the last pose briefly, then ease into a relaxed idle pose
      if (sinceLost > 0.4) {
        for (const [n, r] of Object.entries(IDLE)) this.rot(n, r, 1, 0.06, dt);
        this.bone('Hips').position.lerp(this.hipsRest, rate(0.05, dt));
      }
    } else {
      const hp = pose.Hips;
      if (moveRoot) {
        const hips = this.bone('Hips');
        const target = _v.set(
          this.hipsRest.x - clamp(hp.position.x, -1.5, 1.5) * 0.9,
          this.hipsRest.y + (legs ? clamp(hp.position.y, -0.8, 0.4) : 0),
          this.hipsRest.z - (legs ? clamp(hp.position.z + 1.1, -1, 1) * 0.3 : 0));
        hips.position.lerp(target, rate(0.12, dt));
      }
      this.track('Hips', { x: legs ? hp.rotation.x : 0, y: hp.rotation.y, z: hp.rotation.z }, 0.7, dt, PROF.torso);
      const aim = this.opts.solver === 'aim' && pose.raw;
      if (aim) {
        // 3D aiming solver for the torso and both arms (retarget.js)
        const lm = pose.raw.lm, vis = (i) => lm[i].visibility ?? 1;
        const skip = {};
        for (const s of ['Right', 'Left']) {
          const ix = s === 'Right' ? [13, 15] : [14, 16];
          const hidden = Math.max(vis(ix[0]), vis(ix[1])) < 0.3 && !(hands && hands[s]);
          this.armHidden[s] = hidden ? this.armHidden[s] + dt : 0;
          if (this.armHidden[s] > 0.6) {
            skip[s] = true;    // out of view for a while: hang relaxed instead of guessing
            this.rot(s + 'UpperArm', IDLE[s + 'UpperArm'], 1, 0.05, dt);
            this.rot(s + 'LowerArm', IDLE[s + 'LowerArm'], 1, 0.05, dt);
          }
        }
        this.rt.solveBody(pose.raw.wl, vis, { dt, depth: this.opts.depth, follow: this.opts.follow, lm, aspect: pose.raw.aspect || 4 / 3, lift: this.opts.lift !== false, handsSeen: { Left: !!(hands && hands.Left), Right: !!(hands && hands.Right) }, skip });
      } else {
        this.track('Chest', pose.Spine, 0.25, dt, PROF.torso);
        this.track('Spine', pose.Spine, 0.45, dt, PROF.torso);
      }
      for (const s of ['Right', 'Left']) {
        // trust from landmark visibility: the upper arm needs the elbow, the forearm the wrist too
        // (with the phone framing chest-up the elbows are often below the picture: if the hand tracker
        // sees that hand, the arm is clearly up and in view, so it is trusted reasonably)
        const v = pose.vis ? pose.vis[s] : { elbow: 1, wrist: 1 };
        const seen = hands && hands[s] ? 0.65 : 0;
        const cU = Math.max(seen, smoothstep(0.3, 0.7, v.elbow)), cL = Math.max(seen, Math.min(cU, smoothstep(0.3, 0.7, v.wrist)));
        if (aim) { /* arms done by the aiming solver */ } else if ((this.armHidden[s] = cL < 0.25 ? this.armHidden[s] + dt : 0) > 0.6) {
          // out of view for a while: let the arm hang relaxed instead of guessing
          this.rot(s + 'UpperArm', IDLE[s + 'UpperArm'], 1, 0.05, dt);
          this.rot(s + 'LowerArm', IDLE[s + 'LowerArm'], 1, 0.05, dt);
        } else {
          this.track(s + 'UpperArm', pose[s + 'UpperArm'], 1, dt, PROF.arm, cU);
          this.track(s + 'LowerArm', pose[s + 'LowerArm'], 1, dt, PROF.arm, cL);
        }
        if (legs) {
          // keep knees/hips inside a natural range (no backward knees, no splits)
          const ul = pose[s + 'UpperLeg'], ll = pose[s + 'LowerLeg'];
          this.track(s + 'UpperLeg', { x: clamp(ul.x, -2.0, 0.9), y: clamp(ul.y, -0.8, 0.8), z: clamp(ul.z, -0.9, 0.9), rotationOrder: ul.rotationOrder }, 1, dt, PROF.leg);
          this.track(s + 'LowerLeg', { x: clamp(ll.x, -0.05, 2.4), y: 0, z: 0, rotationOrder: ll.rotationOrder }, 1, dt, PROF.leg);
        } else {
          this.rot(s + 'UpperLeg', IDLE[s + 'UpperLeg'], 1, 0.1, dt);
          this.rot(s + 'LowerLeg', IDLE[s + 'LowerLeg'], 1, 0.1, dt);
        }
      }
    }
    // hands & fingers
    for (const s of ['Right', 'Left']) {
      const hs = hands && hands[s];
      if (hs) this.lastHand[s] = now;
      // the hand tracker's influence fades in quickly and out slowly (no snapping when it flickers)
      this.handW[s] += ((hs ? 1 : 0) - this.handW[s]) * Math.min(1, dt * (hs ? 10 : 3));
      const poseHandZ = pose ? pose[s + 'Hand'].z : 0;
      if (hs && hs.world && this.opts.solver === 'aim') {
        this.rt.solveHand(s, hs.world, { dt, follow: this.opts.follow, weight: Math.max(0.15, this.handW[s]) });
      } else if (hs) {
        const w = this.handW[s];
        this.track(s + 'Hand', { x: hs[s + 'Wrist'].x, y: hs[s + 'Wrist'].y, z: poseHandZ }, 1, dt, PROF.hand, w);
        for (const f of FINGERS) for (const j of JOINTS) {
          const r = hs[s + f + j]; if (!r) continue;
          this.track(s + f + j, r, 1, dt, PROF.finger, w);
        }
      } else if (now - this.lastHand[s] > 0.4 && this.opts.solver === 'aim') {
        this.rt.relaxHand(s, dt);
      } else if (now - this.lastHand[s] > 0.4) {
        // lost hand: relax fingers to a soft natural curl
        if (pose) this.rot(s + 'Hand', { x: 0, y: 0, z: poseHandZ }, 1, 0.2, dt);
        const sign = s === 'Right' ? -1 : 1;
        for (const f of FINGERS) for (const j of JOINTS) {
          this.rot(s + f + j, f === 'Thumb' ? { x: 0, y: 0, z: 0 } : { x: 0, y: 0, z: sign * 0.25 }, 1, 0.08, dt);
        }
      }
    }
    if (legs) this.ground(dt);
    else this.groundOffset += (0 - this.groundOffset) * rate(0.1, dt);
  }

  /** keep the lowest foot on the floor; anchor a planted foot horizontally to stop sliding */
  ground(dt) {
    const hips = this.bone('Hips');
    hips.updateWorldMatrix(true, true);
    const lf = this.bone('LeftFoot').getWorldPosition(new THREE.Vector3());
    const rf = this.bone('RightFoot').getWorldPosition(new THREE.Vector3());
    const low = lf.y < rf.y ? lf : rf, side = lf.y < rf.y ? 'L' : 'R';
    // vertical: floor contact
    const dy = low.y - this.toesRestY;
    hips.position.y -= dy;
    // horizontal: if the same foot stays planted (other foot clearly higher), cancel its drift
    const planted = Math.abs(lf.y - rf.y) > 0.04;
    if (planted) {
      if (!this.footAnchor || this.footAnchor.side !== side) this.footAnchor = { side, x: low.x, z: low.z };
      const k = 0.85;
      hips.position.x -= (low.x - this.footAnchor.x) * k;
      hips.position.z -= (low.z - this.footAnchor.z) * k;
    } else {
      this.footAnchor = null;
    }
  }
}

/** Solve helpers ------------------------------------------------------------------------ */
export function solvePose(result, size, legs) {
  if (!result || !result.landmarks || !result.landmarks[0] || !result.worldLandmarks[0]) return null;
  const lm = result.landmarks[0], wl = result.worldLandmarks[0];
  // need at least shoulders visible
  if ((lm[11].visibility ?? 1) < 0.5 || (lm[12].visibility ?? 1) < 0.5) return null;
  const pose = Kalidokit.Pose.solve(wl, lm, { runtime: 'mediapipe', imageSize: size, enableLegs: legs });
  if (!pose) return null;
  // visibility per avatar arm (mirror convention: the person's LEFT side, landmarks 13/15, drives the
  // avatar's RIGHT arm)
  const vis = (k) => lm[k].visibility ?? 1;
  pose.vis = { Right: { elbow: vis(13), wrist: vis(15) }, Left: { elbow: vis(14), wrist: vis(16) } };
  pose.raw = { wl, lm, aspect: size.width / size.height };          // for the 3D aiming solver
  return pose;
}

/**
 * Assign detected hands to AVATAR sides by proximity to the pose wrists (robust to
 * handedness-label mirroring). Mirror convention (Kalidokit): the person's LEFT wrist
 * (pose landmark 15) drives the avatar's RIGHT hand.
 */
export function solveHands(handResult, poseLm) {
  const out = { Left: null, Right: null };
  if (!handResult || !handResult.landmarks) return out;
  handResult.landmarks.forEach((h, i) => {
    let avatarSide;
    if (poseLm) {
      const d = (p) => Math.hypot(h[0].x - p.x, h[0].y - p.y);
      avatarSide = d(poseLm[15]) < d(poseLm[16]) ? 'Right' : 'Left';
    } else {
      // label assumes a mirrored image; our input is NOT mirrored -> "Left" label = person's right hand
      const label = handResult.handednesses?.[i]?.[0]?.categoryName || handResult.handedness?.[i]?.[0]?.categoryName;
      avatarSide = label === 'Left' ? 'Left' : 'Right';
    }
    out[avatarSide] = Kalidokit.Hand.solve(h, avatarSide);
    if (out[avatarSide]) { out[avatarSide].world = handResult.worldLandmarks?.[i] || null; out[avatarSide].lm = h; }
  });
  return out;
}
