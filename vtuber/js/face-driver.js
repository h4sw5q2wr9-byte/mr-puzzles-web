// Stateful face front-end: per-person adaptive neutral (blendshapes AND landmark geometry), blink
// hysteresis, tracking confidence, and the brief red flash. Feeds the pure mapFace().
// Used identically by the app (live camera) and by tests/face_replay.mjs (recorded real signals).
import { mapFace, DEFAULT_TUNING } from './face-map.js?v=20261113.2020-a8bdf9a';
import { faceGeometry } from './face-geom.js?v=20261113.2020-a8bdf9a';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
// typical RELAXED levels of the noisy blendshapes (measured on tests/signals/*): a person's baseline
// starts at min(first value, prior) and then follows their resting face
const PRIOR = { browDown: 0.3, eyeSquint: 0.45, mouthPucker: 0.35, mouthSmile: 0.15, mouthUpperUp: 0.12, eyeBlink: 0.2,
  browInnerUp: 0.15, browOuterUp: 0.1, mouthStretch: 0.1, mouthPress: 0.1, mouthFunnel: 0.1, mouthFrown: 0.05, jawOpen: 0.05 };
const prior = (k) => PRIOR[k.replace(/(Left|Right)$/, '')] ?? 0.08;
// geometry keys: kind 'rel' -> delta = value / base - 1, 'abs' -> value - base; sigma = typical expression size
const GEO = {
  eyeOpenLeft: ['rel', 0.15], eyeOpenRight: ['rel', 0.15],
  browMidLeft: ['abs', 0.03], browMidRight: ['abs', 0.03], browInnerLeft: ['abs', 0.03], browInnerRight: ['abs', 0.03],
  browOuterLeft: ['abs', 0.03], browOuterRight: ['abs', 0.03],
  cornerLeft: ['abs', 0.025], cornerRight: ['abs', 0.025],
  mouthOpen: ['min', 0.04], mouthWidth: ['rel', 0.05], mouthShift: ['abs', 0.02],
};

export class FaceDriver {
  constructor() { this.reset(); }
  reset() {
    this.bsBase = null; this.geoBase = null; this.t = 0; this.blinkState = { Left: false, Right: false };
    this.angerSlow = 0; this.flash = 0; this.flashT = 1e9; this.armed = true; this.calib = null; this.locked = false;
  }

  /** collect the next ~1.5 s of frames as the person's neutral face */
  startCalibration(frames = 30) { this.calib = { n: frames, bs: [], geo: [] }; }

  _calibStep(bs, geo) {
    const c = this.calib; c.bs.push(bs); if (geo) c.geo.push(geo);
    if (c.bs.length < c.n) return false;
    const med = (arr, k) => { const v = arr.map((o) => o[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
    this.bsBase = {}; for (const k in c.bs[0]) this.bsBase[k] = Math.min(0.6, med(c.bs, k));
    if (c.geo.length) { this.geoBase = {}; for (const k in GEO) this.geoBase[k] = med(c.geo, k); }
    this.calib = null; this.locked = true;      // an explicit calibration is trusted; adaptation only slows down
    return true;
  }

  /**
   * one frame. face: {bs, lm: (i)=>[x,y] | null, yaw} ; returns {weights, mood, cues, conf, calibrated}
   */
  step({ bs, lm = null, yaw = 0 }, dt, { tuning = DEFAULT_TUNING, mirror = false } = {}) {
    this.t += dt;
    const geoRaw = lm ? faceGeometry(lm) : null;
    let justCalibrated = false;
    if (this.calib) justCalibrated = this._calibStep(bs, geoRaw);
    const slow = this.locked ? 4 : 1;

    // ---- blendshape baseline: fast down, slow up (a resting face is the low envelope) ----------------
    if (!this.bsBase) { this.bsBase = {}; for (const k in bs) this.bsBase[k] = Math.min(bs[k], prior(k)); }
    const b = {};
    for (const k in bs) {
      let base = this.bsBase[k] ?? 0; const x = bs[k];
      base += (x - base) * (x < base ? Math.min(1, dt / 0.6) : Math.min(1, dt / (45 * slow)));
      base = Math.min(base, 0.6); this.bsBase[k] = base;
      b[k] = clamp01((x - base) / (1 - base));
    }
    // ---- geometry baseline: robust (Cauchy-weighted) slow average of the person's own RELAXED face.
    // Each region (eyes / brows / mouth) only starts and updates its baseline while the blendshapes say
    // that region is relaxed, so starting mid-scream or mid-smile does not poison the neutral. Until a
    // region has a baseline, its geometric deltas are 0 (blendshapes only).
    let geo = null;
    if (geoRaw) {
      this.geoBase ||= {};
      const v = (k) => b[k] ?? 0;
      const relaxed = {
        eye: v('eyeSquintLeft') < 0.15 && v('eyeSquintRight') < 0.15 && v('eyeBlinkLeft') < 0.2 && v('eyeBlinkRight') < 0.2 && Math.abs(yaw) < 0.3,
        brow: v('browDownLeft') < 0.3 && v('browDownRight') < 0.3 && v('browOuterUpLeft') < 0.2 && v('browOuterUpRight') < 0.2 && v('browInnerUp') < 0.25,
        mouth: v('jawOpen') < 0.12 && v('mouthSmileLeft') < 0.25 && v('mouthSmileRight') < 0.25 && v('mouthPucker') < 0.4 && v('mouthFunnel') < 0.3,
      };
      const region = (k) => (k.startsWith('eye') ? 'eye' : k.startsWith('brow') ? 'brow' : 'mouth');
      geo = {};
      for (const k in GEO) {
        const [kind, sig] = GEO[k]; const x = geoRaw[k]; let base = this.geoBase[k];
        const ok = relaxed[region(k)];
        if (base === undefined) { if (ok) this.geoBase[k] = base = x; else { geo[k] = 0; continue; } }
        const d = kind === 'rel' ? x / base - 1 : x - base;
        if (kind === 'min') base += (x - base) * (x < base ? Math.min(1, dt / 0.5) : ok ? Math.min(1, dt / (40 * slow)) : 0);
        else if (ok) {
          const tau = (this.t < 3 ? 3 : 14) * slow;
          base += (kind === 'rel' ? base * d : d) * Math.min(1, dt / tau) / (1 + (d / sig) ** 2);
        }
        this.geoBase[k] = base;
        geo[k] = kind === 'rel' ? x / base - 1 : x - base;
      }
    }
    // ---- blink hysteresis (no flicker between half-lid and closed) ------------------------------------
    for (const X of ['Left', 'Right']) {
      const k = 'eyeBlink' + X, v = b[k] ?? 0;
      if (!this.blinkState[X] && v > 0.62) this.blinkState[X] = true;
      else if (this.blinkState[X] && v < 0.38) this.blinkState[X] = false;
      b[k] = this.blinkState[X] ? Math.max(v, 0.82) : Math.min(v, 0.58);
    }
    // ---- confidence: a turned head hides one side of the face ------------------------------------------
    const conf = 1 - smoothstep(0.15, 0.5, Math.abs(yaw));
    const r = mapFace(b, { mirror, tuning, geom: geo, conf });

    // ---- red flash: a SUDDEN rise of anger / shouting, then it fades (never a permanent red screen) -----
    const a = r.mood.anger;
    this.angerSlow += (a - this.angerSlow) * Math.min(1, dt / 0.7);
    this.flashT += dt;
    if (this.armed && a > 0.5 && a - this.angerSlow > 0.12) { this.flashT = 0; this.armed = false; }
    if (!this.armed && a < 0.3 && this.flashT > 1.2) this.armed = true;
    const ft = this.flashT, env = ft < 0.06 ? ft / 0.06 : ft < 0.36 ? 1 : Math.max(0, 1 - (ft - 0.36) / 0.7);
    const T = { ...DEFAULT_TUNING, ...tuning };
    r.mood.red = T.autoMoodColor ? env * (0.75 + 0.25 * a) : 0;
    if (!T.shading) { r.mood.shade = r.mood.shadeL = r.mood.shadeR = 0; } else {
      r.mood.shade *= T.shading; r.mood.shadeL *= T.shading; r.mood.shadeR *= T.shading;
    }
    r.conf = conf; r.calibrated = justCalibrated; r.geo = geo;
    return r;
  }
}

/** FaceLandmarker result -> FaceDriver input */
export function driverInput(faceResult, aspect) {
  const L = faceResult.faceLandmarks[0];
  const bs = {}; for (const c of faceResult.faceBlendshapes[0].categories) bs[c.categoryName] = c.score;
  const m = faceResult.facialTransformationMatrixes?.[0]?.data;
  return { bs, lm: (i) => [L[i].x * aspect, L[i].y], yaw: m ? Math.atan2(m[8], m[10]) : 0 };
}
