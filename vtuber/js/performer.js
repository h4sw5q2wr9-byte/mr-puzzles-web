// One code path from tracker results to Mr. Puzzles, shared by the live camera, photos and video replay.
//  face  : FaceDriver (per-person baselines, styles, red flash) -> smoothing -> geometric constraints
//  head  : Kalidokit face solve
//  arms / hands / body : Kalidokit pose + hand solves (four-digit hands, confidence-gated arms)
// Face processing never depends on hand / body results, so new motion features cannot corrupt it.
// Every step returns a compact snapshot; replays store snapshots and re-apply them frame-exactly.
import * as Kalidokit from 'kalidokit';
import { FaceDriver, driverInput } from './face-driver.js?v=20261113.1012-a627f0d';
import { STYLES } from './face-map.js?v=20261113.1012-a627f0d';
import { solvePose, solveHands } from './body-rig.js?v=20261113.1012-a627f0d';

const POSES = {   // optional one-tap cartoon poses (blend over tracking, then fade)
  shock: { eyeBig_L: 1, eyeBig_R: 1, browUp_L: 1, browUp_R: 1, pupilSmall: 0.8, jawOpen: 0.9, mouthInterior: 0.9, mouthCenterUp: 0.4, _stress: 1, _sweat: 1 },
  rage: { eyeAngry_L: 1, eyeAngry_R: 1, browDown_L: 1, browDown_R: 1, eyeRotOut_L: 0.5, eyeRotOut_R: 0.5, mouthGrit: 1, jawOpen: 0.55, mouthInterior: 0.6, pupilSmall: 0.6, _red: 1 },
  smug: { eyeHalfLid_L: 0.7, eyeHalfLid_R: 0.75, browArch_L: 0.9, mouthSmile_R: 0.9, mouthTilt_R: 0.35, _shade: 0.5 },
  sideways: { mouthTilt_L: 1, eyeSquint_R: 0.5, browDown_R: 0.7, browUp_L: 0.7, jawOpen: 0.4, mouthInterior: 0.35 },
  sad: { eyeDroop_L: 1, eyeDroop_R: 1, browInnerUp: 1, eyeRotIn_L: 0.7, eyeRotIn_R: 0.7, pupilBig: 0.8, mouthFrown_L: 0.8, mouthFrown_R: 0.8, mouthWave: 0.5, _shade: 0.6 },
  laugh: { eyeHappy_L: 1, eyeHappy_R: 1, mouthSmile_L: 1, mouthSmile_R: 1, jawOpen: 0.9, mouthInterior: 0.8 },
  dead: { eyeHalfLid_L: 0.95, eyeHalfLid_R: 0.95, eyeStretch_L: 0.8, eyeStretch_R: 0.8, eyeDroop_L: 0.6, eyeDroop_R: 0.6, mouthFrown_L: 0.4, mouthFrown_R: 0.4, _shade: 1, _stress: 0.7 },
};

export class Performer {
  constructor({ avatar, getRig, state }) {
    this.avatar = avatar; this.getRig = getRig; this.state = state;
    this.driver = new FaceDriver();
    this.pose = null; this.poseT = 0; this.lostT = 0; this.voice = 0;
  }

  /** start a one-tap pose (or toggle it off) */
  triggerPose(name) { this.pose = this.pose && this.pose.name === name ? null : { name, t: 0 }; }

  /**
   * res: tracker result on the ANALYSIS frame; size: {width, height}; opts: {track, now, dt, arMode}
   * returns a snapshot {face, head, body, hands} that apply() can reproduce exactly
   */
  track(res, size, { track = 'hands', now = 0, dt = 1 / 30 } = {}) {
    const st = this.state, T = st.tuning;
    const snap = { t: now, face: null, head: null, body: null, hands: null };
    // ---- face (independent of everything else) ----------------------------------------------------
    const fl = res.face?.faceLandmarks?.[0];
    if (fl) {
      const inp = driverInput(res.face, size.width / size.height);
      const r = this.driver.step(inp, dt, { tuning: T, mirror: true });
      snap.face = { weights: r.weights, mood: r.mood, cues: r.cues, conf: r.conf, calibrated: r.calibrated };
      // Kalidokit rescales the landmark array it is given IN PLACE (to pixels) -> give it a copy
      const fs = Kalidokit.Face.solve(fl.map((p) => ({ x: p.x, y: p.y, z: p.z })), { runtime: 'mediapipe', imageSize: size, smoothBlink: false });
      if (fs) snap.head = fs.head;
      // face centre (analysis-frame x) for assigning hands when the body model is off / lost
      snap.faceX = (fl[33].x + fl[263].x) / 2; snap.faceLm = fl;
    }
    // ---- arms / hands / body ------------------------------------------------------------------------
    if (track !== 'face') {
      snap.body = solvePose(res.pose, size, track === 'full');
      const hs = solveHands(res.hands, snap.body ? res.pose.landmarks[0] : null, snap.faceX ?? null);
      snap.hands = { Left: hs.Left, Right: hs.Right };
    }
    return snap;
  }

  /** show a snapshot (live: smoothed; replay/photo: exact) */
  apply(snap, dt, { track = 'hands', now = 0, exact = false, arMode = null } = {}) {
    const av = this.avatar, rig = this.getRig(), st = this.state, T = st.tuning;
    if (!av.vrm || !rig) return;
    const fx = { static: 0, stress: 0, sweat: 0 };
    let weights = snap.face ? { ...snap.face.weights } : null, mood = snap.face ? { ...snap.face.mood } : {};
    if (weights) {
      this.lostT = 0;
      const c = snap.face.cues || {};
      if (st.sweat) { fx.stress = Math.max(c.fear || 0, (c.tired || 0) * 0.7, (c.surprise || 0) * 0.5); fx.sweat = Math.max(c.fear || 0, (c.anger || 0) * 0.6, (c.surprise || 0) * 0.6); }
      // optional: the mouth also follows the microphone level (talking reads even with a small face)
      if (st.lipsync && this.voice > 0.02) {
        weights.jawOpen = Math.max(weights.jawOpen || 0, Math.min(0.7, this.voice * 0.9));
        weights.mouthCenterUp = Math.max(weights.mouthCenterUp || 0, this.voice * 0.3);
      }
    } else {
      this.lostT += dt;
      if (st.staticFx) fx.static = Math.min(0.85, Math.max(0, this.lostT - 0.6) * 1.5);
    }
    // ---- one-tap poses: blend in, hold, blend out ---------------------------------------------------
    if (this.pose) {
      const p = POSES[this.pose.name]; this.pose.t += dt;
      const t = this.pose.t, env = Math.min(1, t / 0.15) * (t < 1.8 ? 1 : Math.max(0, 1 - (t - 1.8) / 0.4));
      if (env <= 0 && t > 1.8) this.pose = null;
      else {
        weights ||= {};
        for (const g of av.faceGroups) weights[g] = (weights[g] || 0) * (1 - env) + (p[g] || 0) * env;
        if (p._red) mood.red = Math.max(mood.red || 0, env * (t < 0.9 ? 1 : 0.3));
        if (p._shade) { mood.shadeL = Math.max(mood.shadeL || 0, p._shade * env); mood.shadeR = Math.max(mood.shadeR || 0, p._shade * env); }
        if (p._stress) fx.stress = Math.max(fx.stress, p._stress * env);
        if (p._sweat) fx.sweat = Math.max(fx.sweat, p._sweat * env);
      }
    }
    if (exact && weights) av.applyFace(weights, dt, mood, fx);
    else av.setFace(weights, dt, mood, { responsiveness: T.responsiveness, conf: snap.face ? snap.face.conf : 1, pop: (STYLES[T.style] || STYLES.zamination).pop, fx });
    // ---- bones ------------------------------------------------------------------------------------------
    rig.snap = exact;
    if (snap.head) rig.applyHead({ head: snap.head }, dt, 0); else rig.relaxHead(dt);
    if (track === 'face') rig.applyBody(null, null, { now, dt });
    else rig.applyBody(snap.body, snap.hands, { legs: track === 'full', now, dt, moveRoot: track === 'full' && !arMode, ground: !arMode });
    rig.snap = false;
  }
}
export const POSE_NAMES = Object.keys(POSES);
