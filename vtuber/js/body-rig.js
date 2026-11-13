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
  }
  worldY(n) { const b = this.bone(n); b.updateWorldMatrix(true, false); return b.getWorldPosition(_v).y; }

  rot(name, r, damp = 1, k = 0.3, dt = 1 / 60) {
    const b = this.bone(name); if (!b || !r) return;
    _e.set((r.x || 0) * damp, (r.y || 0) * damp, (r.z || 0) * damp, r.rotationOrder || 'XYZ');
    _q.setFromEuler(_e);
    b.quaternion.slerp(_q, rate(k, dt));
  }

  /** head rotation from Kalidokit.Face.solve (radians). Split between neck and head. */
  /** mirror=false: the avatar copies you like a puppet facing you (your left = his left; Kalidokit's
   *  default on an unmirrored camera image). mirror=true: like a selfie mirror. The face features use
   *  the SAME flag (main.js), so head and face can never disagree. */
  applyHead(face, dt, hipsYaw = 0, mirror = false) {
    if (!face) return;
    const h = face.head, m = mirror ? -1 : 1;
    const t = { x: clamp(h.x, -0.8, 0.8), y: clamp(m * h.y - hipsYaw, -0.9, 0.9), z: clamp(m * h.z, -0.6, 0.6) };
    this.rot('Neck', t, 0.55, 0.35, dt);
    this.rot('Head', t, 0.45, 0.35, dt);
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
      this.rot('Hips', { x: legs ? hp.rotation.x : 0, y: hp.rotation.y, z: hp.rotation.z }, 0.7, 0.25, dt);
      this.rot('Chest', pose.Spine, 0.25, 0.3, dt);
      this.rot('Spine', pose.Spine, 0.45, 0.3, dt);
      for (const s of ['Right', 'Left']) {
        this.rot(s + 'UpperArm', pose[s + 'UpperArm'], 1, 0.35, dt);
        this.rot(s + 'LowerArm', pose[s + 'LowerArm'], 1, 0.35, dt);
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
    // hands & fingers
    for (const s of ['Right', 'Left']) {
      const hs = hands && hands[s];
      if (hs) this.lastHand[s] = now;
      const poseHandZ = pose ? pose[s + 'Hand'].z : 0;
      if (hs) {
        this.rot(s + 'Hand', { x: hs[s + 'Wrist'].x, y: hs[s + 'Wrist'].y, z: poseHandZ }, 1, 0.35, dt);
        for (const f of FINGERS) for (const j of JOINTS) {
          const r = hs[s + f + j]; if (!r) continue;
          this.rot(s + f + j, r, 1, 0.4, dt);
        }
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
  return Kalidokit.Pose.solve(wl, lm, { runtime: 'mediapipe', imageSize: size, enableLegs: legs });
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
  });
  return out;
}
