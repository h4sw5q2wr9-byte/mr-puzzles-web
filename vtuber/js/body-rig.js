// Applies Kalidokit solutions (the same solver Kalidoface 3D uses) to the VRM humanoid,
// with frame-rate independent smoothing, per-limb tracking-loss recovery and foot grounding.
import * as THREE from 'three';
import * as Kalidokit from 'kalidokit';
import { VRMSchema } from '@pixiv/three-vrm';

const R = Kalidokit.Utils.RestingDefault.Pose;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// lerp factor tuned at 60 fps -> same feel at any frame rate
const rate = (k, dt) => 1 - Math.pow(1 - k, Math.max(dt, 1 / 240) * 60);

const IDLE = {
  RightUpperArm: { x: 0, y: 0, z: -1.25 }, LeftUpperArm: { x: 0, y: 0, z: 1.25 },
  RightLowerArm: { x: 0, y: 0, z: 0 }, LeftLowerArm: { x: 0, y: 0, z: 0 },
  RightHand: { x: 0, y: 0, z: 0 }, LeftHand: { x: 0, y: 0, z: 0 },
  RightUpperLeg: { x: 0, y: 0, z: 0 }, LeftUpperLeg: { x: 0, y: 0, z: 0 },
  RightLowerLeg: { x: 0, y: 0, z: 0 }, LeftLowerLeg: { x: 0, y: 0, z: 0 },
  Spine: { x: 0, y: 0, z: 0 }, Chest: { x: 0, y: 0, z: 0 }, Hips: { x: 0, y: 0, z: 0 },
};
// Mr. Puzzles has FOUR digits per hand (the VRM has Thumb / Index / Middle / Little bones, no Ring):
// the human ring + little finger are blended into his last digit instead of inventing a fifth finger.
const FINGERS = ['Thumb', 'Index', 'Middle', 'Little'];
const JOINTS = ['Proximal', 'Intermediate', 'Distal'];
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _r = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();

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
    this.armGain = 1.12;      // ZAMination: arm poses pushed a little further from rest
    this.snap = false;        // true = apply targets exactly (photo / replay frames)
  }
  worldY(n) { const b = this.bone(n); b.updateWorldMatrix(true, false); return b.getWorldPosition(_v).y; }

  rot(name, r, damp = 1, k = 0.3, dt = 1 / 60) {
    const b = this.bone(name); if (!b || !r) return;
    _e.set((r.x || 0) * damp, (r.y || 0) * damp, (r.z || 0) * damp, r.rotationOrder || 'XYZ');
    _q.setFromEuler(_e);
    b.quaternion.slerp(_q, this.snap ? 1 : rate(k, dt));
  }

  /** head rotation from Kalidokit.Face.solve (radians). Split between neck and head. */
  /** Left/right convention: the app always analyses the image flipped relative to what it SHOWS, so
   *  Kalidokit's mirror convention makes the avatar copy the person shown on screen (main.js). */
  applyHead(face, dt, hipsYaw = 0) {
    if (!face) return;
    const h = face.head;
    const t = { x: clamp(h.x, -0.8, 0.8), y: clamp(h.y - hipsYaw, -0.9, 0.9), z: clamp(h.z, -0.6, 0.6) };
    this.rot('Neck', t, 0.55, 0.35, dt);
    this.rot('Head', t, 0.45, 0.35, dt);
  }

  relaxHead(dt) { this.rot('Neck', { x: 0, y: 0, z: 0 }, 1, 0.05, dt); this.rot('Head', { x: 0, y: 0, z: 0 }, 1, 0.05, dt); }

  /**
   * @param pose   Kalidokit.Pose.solve output or null (lost)
   * @param hands  {Left: Kalidokit.Hand.solve output|null, Right: ...} keyed by AVATAR side
   * @param opts   {legs:boolean, now:number(seconds), dt}
   */
  applyBody(pose, hands, { legs = false, now = 0, dt = 1 / 60, moveRoot = true, ground = true } = {}) {
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
      this.rot('Hips', { x: legs ? hp.rotation.x : 0, y: hp.rotation.y, z: hp.rotation.z }, 0.7, 0.25, dt);
      this.rot('Chest', pose.Spine, 0.25, 0.3, dt);
      this.rot('Spine', pose.Spine, 0.45, 0.3, dt);
      for (const s of ['Right', 'Left']) {
        // arms: aimed straight along the tracked shoulder -> elbow -> wrist directions (see aimArm)
        const arm = pose.arms && pose.arms[s];
        if (arm) this.aimArm(s, arm, dt);
        else { this.rot(s + 'UpperArm', IDLE[s + 'UpperArm'], 1, 0.08, dt); this.rot(s + 'LowerArm', IDLE[s + 'LowerArm'], 1, 0.08, dt); }
        if (legs) {
          // keep knees/hips inside a natural range (no backward knees, no splits)
          const ul = pose[s + 'UpperLeg'], ll = pose[s + 'LowerLeg'];
          this.rot(s + 'UpperLeg', { x: clamp(ul.x, -2.0, 0.9), y: clamp(ul.y, -0.8, 0.8), z: clamp(ul.z, -0.9, 0.9), rotationOrder: ul.rotationOrder }, 1, 0.3, dt);
          this.rot(s + 'LowerLeg', { x: clamp(ll.x, -0.05, 2.4), y: 0, z: 0, rotationOrder: ll.rotationOrder }, 1, 0.3, dt);
        } else {
          this.rot(s + 'UpperLeg', IDLE[s + 'UpperLeg'], 1, 0.1, dt);
          this.rot(s + 'LowerLeg', IDLE[s + 'LowerLeg'], 1, 0.1, dt);
        }
      }
    }
    // hands & fingers: wrist orientation from the palm, four-digit curls from the joint angles
    for (const s of ['Right', 'Left']) {
      const hw = hands && hands[s];
      if (hw) { this.lastHand[s] = now; this.aimHand(s, hw, dt); }
      else if (now - this.lastHand[s] > 0.4) {
        // lost hand: wrist straightens, fingers relax to a soft natural curl
        this.rot(s + 'Hand', { x: 0, y: 0, z: 0 }, 1, 0.12, dt);
        for (const f of FINGERS) for (const j of JOINTS) this.curl(s, f, j, f === 'Thumb' ? 0.1 : 0.3, 0.08, dt);
      }
    }
    if (legs && ground) this.ground(dt);   // (AR Lens places the avatar itself: no world-space grounding)
    else this.groundOffset += (0 - this.groundOffset) * rate(0.1, dt);
  }

  // ---- direct arm / hand solver ------------------------------------------------------------------
  // Landmark vectors are converted to MODEL space with M(p) = (x, -y, z) (analysis frame = mirror of the
  // displayed picture, model faces -Z; see main.js), so the avatar copies the person shown on screen.
  modelQ(node) { return this.vrm.scene.getWorldQuaternion(_qa).invert().multiply(node.getWorldQuaternion(_qb)); }
  slerpTo(node, q, k, dt) { node.quaternion.slerp(q, this.snap ? 1 : rate(k, dt)); }

  /** arm: {sh, el, wr} world landmarks (metres). Upper / lower arm point along the real limb. */
  aimArm(side, arm, dt) {
    const up = this.bone(side + 'UpperArm'), lo = this.bone(side + 'LowerArm'); if (!up || !lo) return;
    const rest = _r.set(side === 'Left' ? -1 : 1, 0, 0);
    const M = (p) => new THREE.Vector3(p.x, -p.y, p.z * 0.6);          // depth is the least reliable axis
    const dU = M(arm.el).sub(M(arm.sh)).normalize(), dL = M(arm.wr).sub(M(arm.el)).normalize();
    const pQ = this.modelQ(up.parent);
    const qU = exaggerate(new THREE.Quaternion().setFromUnitVectors(rest, dU.applyQuaternion(pQ.clone().invert())), this.armGain);
    this.slerpTo(up, qU, 0.4, dt);
    const uQ = pQ.multiply(qU);
    const qL = exaggerate(new THREE.Quaternion().setFromUnitVectors(rest, dL.applyQuaternion(uQ.invert())), Math.min(1.08, this.armGain));
    this.slerpTo(lo, qL, 0.4, dt);
  }

  /** hand: 21 hand world landmarks. Wrist orientation from the palm frame; four digits curl. */
  aimHand(side, hw, dt) {
    const hand = this.bone(side + 'Hand'); if (!hand) return;
    const M = (p) => new THREE.Vector3(p.x, -p.y, p.z);
    const f = M(hw[9]).sub(M(hw[0])).normalize();                       // wrist -> middle knuckle
    const a = M(hw[5]).sub(M(hw[17])); a.sub(f.clone().multiplyScalar(a.dot(f))).normalize();   // pinky -> index
    const n = f.clone().cross(a);
    // rest pose (T-pose): fingers along +-X, knuckle line pinky->index pointing forward (-Z)
    const fr = new THREE.Vector3(side === 'Left' ? -1 : 1, 0, 0), ar = new THREE.Vector3(0, 0, -1), nr = fr.clone().cross(ar);
    const Mo = new THREE.Matrix4().makeBasis(f, a, n), Mr = new THREE.Matrix4().makeBasis(fr, ar, nr);
    const qW = new THREE.Quaternion().setFromRotationMatrix(Mo.multiply(Mr.transpose()));
    const local = this.modelQ(hand.parent).invert().multiply(qW);
    this.slerpTo(hand, local, 0.45, dt);
    // finger curls from the joint angles of the tracked hand
    const P = (i) => M(hw[i]);
    const bend = (i, j, k) => { const u = P(j).sub(P(i)).normalize(), v = P(k).sub(P(j)).normalize(); return Math.acos(Math.max(-1, Math.min(1, u.dot(v)))); };
    const chain = { Index: [5, 6, 7, 8], Middle: [9, 10, 11, 12], Ring: [13, 14, 15, 16], Little: [17, 18, 19, 20] };
    const curls = (c) => [bend(0, c[0], c[1]) - 0.12, bend(c[0], c[1], c[2]), bend(c[1], c[2], c[3])];
    const res = {};
    for (const fn of ['Index', 'Middle', 'Ring', 'Little']) res[fn] = curls(chain[fn]);
    // his 4th digit = average of the human ring + little finger
    res.Little = res.Little.map((v, i) => (v + res.Ring[i]) / 2);
    res.Thumb = [bend(0, 1, 2) * 0.5 - 0.15, bend(1, 2, 3), bend(2, 3, 4)];
    for (const fn of FINGERS) JOINTS.forEach((j, i) => this.curl(side, fn, j, res[fn][i] * (fn === 'Thumb' ? 1 : 1.1), 0.5, dt));
  }

  /** bend one finger joint towards the palm by `ang` radians (his rig: palm faces -Y in T-pose) */
  curl(side, finger, joint, ang, k, dt) {
    const b = this.bone(side + finger + joint); if (!b) return;
    ang = Math.max(-0.15, Math.min(1.7, ang));
    let axis;
    if (finger === 'Thumb') axis = _r.set(side === 'Left' ? -0.7 : 0.7, 0, side === 'Left' ? 0.7 : 0.7).normalize();
    else axis = _r.set(0, 0, side === 'Left' ? 1 : -1);
    this.slerpTo(b, _qc.setFromAxisAngle(axis, ang), k, dt);
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

// exaggerate a rotation away from rest (ZAMination arms), with a dead zone so tiny moves stay calm
function exaggerate(q, gain) {
  const ang = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  if (gain <= 1 || ang < 0.08) return q;
  const t = Math.min(gain, (ang + 0.35) / ang);
  return new THREE.Quaternion().slerp(q, t);          // slerp from identity; t > 1 extrapolates
}

const xyz = (p) => ({ x: p.x, y: p.y, z: p.z });
/** Solve helpers ------------------------------------------------------------------------ */
export function solvePose(result, size, legs) {
  if (!result || !result.landmarks || !result.landmarks[0] || !result.worldLandmarks[0]) return null;
  const lm = result.landmarks[0], wl = result.worldLandmarks[0];
  // need at least shoulders visible
  if ((lm[11].visibility ?? 1) < 0.5 || (lm[12].visibility ?? 1) < 0.5) return null;
  const cp = (a) => a.map((q) => ({ x: q.x, y: q.y, z: q.z, visibility: q.visibility }));   // Kalidokit mutates its inputs
  const p = Kalidokit.Pose.solve(cp(wl), cp(lm), { runtime: 'mediapipe', imageSize: size, enableLegs: legs });
  if (!p) return null;
  // per-arm confidence (Kalidokit mirror convention: person's left side (13/15) drives the avatar's Right)
  const vis = (i) => lm[i].visibility ?? 1;
  // mirror convention on the analysis frame: person-in-frame's left (11/13/15) drives the avatar's Right
  // MediaPipe also "guesses" joints outside the picture with medium confidence: require a confident,
  // in-frame elbow and wrist, otherwise that arm rests (no phantom gestures)
  const inFrame = (i) => lm[i].x > -0.02 && lm[i].x < 1.02 && lm[i].y > -0.02 && lm[i].y < 1.0;
  const arm = (a, b, c) => (Math.min(vis(b), vis(c)) > 0.65 && inFrame(b) && inFrame(c) ? { sh: xyz(wl[a]), el: xyz(wl[b]), wr: xyz(wl[c]) } : null);
  p.arms = { Right: arm(11, 13, 15), Left: arm(12, 14, 16) };
  return p;
}

/**
 * Assign detected hands to AVATAR sides by proximity to the pose wrists (robust to
 * handedness-label mirroring). Mirror convention (Kalidokit): the person's LEFT wrist
 * (pose landmark 15) drives the avatar's RIGHT hand.
 */
export function solveHands(handResult, poseLm, faceCenterX = null) {
  const out = { Left: null, Right: null, lm: { Left: null, Right: null } };
  if (!handResult || !handResult.landmarks) return out;
  handResult.landmarks.forEach((h, i) => {
    let avatarSide;
    if (poseLm) {
      const d = (p) => Math.hypot(h[0].x - p.x, h[0].y - p.y);
      avatarSide = d(poseLm[15]) < d(poseLm[16]) ? 'Right' : 'Left';
    } else if (faceCenterX !== null) {
      // no body model: a hand on the image side of the person's own left (image right) is their left hand
      // -> mirror convention -> avatar's Right (same rule as the pose wrists above)
      avatarSide = h[0].x > faceCenterX ? 'Right' : 'Left';
    } else {
      const label = handResult.handednesses?.[i]?.[0]?.categoryName || handResult.handedness?.[i]?.[0]?.categoryName;
      avatarSide = label === 'Left' ? 'Right' : 'Left';
    }
    if (out[avatarSide]) return;          // two hands on one side: keep the first (more confident) one
    const w = handResult.worldLandmarks?.[i] || h;
    out[avatarSide] = w.map(xyz);
    out.lm[avatarSide] = h;
  });
  return out;
}
