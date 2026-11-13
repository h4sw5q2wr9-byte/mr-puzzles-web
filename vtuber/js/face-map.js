// Maps MediaPipe FaceLandmarker blendshapes (52 ARKit-style coefficients) to
// Mr. Puzzles' own morph groups. Pure functions: no DOM, no three.js (unit-testable in node).
//
// Side convention: the avatar behaves like a MIRROR (same as Kalidoface/Kalidokit):
// the user's left side drives the avatar side that appears on the same side of the screen,
// i.e. the avatar's RIGHT. `mirror:false` maps user-left -> avatar-left instead.
//
// MediaPipe's "Left"/"Right" blendshape suffixes refer to the subject's own left/right
// (verified with tests/face_side_check.mjs on a wink clip; see docs/REPORT.md).

export const AVATAR_GROUPS = [
  'eyeBlink_L', 'eyeBlink_R', 'eyeWide_L', 'eyeWide_R', 'eyeSquint_L', 'eyeSquint_R', 'eyeHappy_L', 'eyeHappy_R',
  'eyeBig_L', 'eyeBig_R', 'eyeTall_L', 'eyeTall_R', 'eyeFlat_L', 'eyeFlat_R', 'eyeHalfLid_L', 'eyeHalfLid_R',
  'eyeDroop_L', 'eyeDroop_R', 'eyeAngry_L', 'eyeAngry_R',
  'browUp_L', 'browUp_R', 'browDown_L', 'browDown_R', 'browOuterUp_L', 'browOuterUp_R', 'browArch_L', 'browArch_R', 'browInnerUp',
  'lookLeft', 'lookRight', 'lookUp', 'lookDown', 'pupilSmall',
  'jawOpen', 'mouthInterior', 'mouthSmile_L', 'mouthSmile_R', 'mouthFrown_L', 'mouthFrown_R', 'mouthUpper_L', 'mouthUpper_R',
  'mouthCenterUp', 'mouthWave', 'mouthPucker', 'mouthGrit', 'mouthTilt_L', 'mouthTilt_R', 'eyeCorrect_L', 'eyeCorrect_R',
];
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// linear remap of [lo,hi] -> [0,1] with a gentle ease so small noise near lo is suppressed
export const remap = (v, lo, hi) => {
  const t = clamp01((v - lo) / (hi - lo));
  return t * t * (3 - 2 * t) * 0.35 + t * 0.65;
};

export const DEFAULT_TUNING = {
  intensity: 1.0,      // global expression gain ("theatrical" slider)
  eyeIntensity: 1.0,
  mouthIntensity: 1.0,
  browIntensity: 1.0,
  gaze: 1.0,
  autoMoodColor: true,
};

/** neutral = optional calibration snapshot {name: value} captured with a relaxed face */
export function calibrated(bs, neutral) {
  if (!neutral) return bs;
  const out = {};
  for (const k in bs) {
    const n = Math.min(neutral[k] ?? 0, 0.6);
    out[k] = clamp01((bs[k] - n) / (1 - n));
  }
  return out;
}

/**
 * @param {Object<string,number>} bsRaw  blendshape name -> score
 * @param {Object} opts {mirror, neutral, tuning}
 * @returns {{weights:Object<string,number>, mood:{red:number, green:number}}}
 */
export function mapFace(bsRaw, { mirror = true, neutral = null, tuning = DEFAULT_TUNING } = {}) {
  const b = calibrated(bsRaw, neutral);
  const g = (k) => b[k] ?? 0;
  const T = { ...DEFAULT_TUNING, ...tuning };
  const I = T.intensity, eI = I * T.eyeIntensity, bI = I * T.browIntensity, mI = I * T.mouthIntensity;
  const A = mirror ? { Left: 'R', Right: 'L' } : { Left: 'L', Right: 'R' };   // user side -> avatar side
  const w = Object.fromEntries(AVATAR_GROUPS.map((n) => [n, 0]));
  const avg = (k) => (g(k + 'Left') + g(k + 'Right')) / 2;

  // ---- global emotion signals (the face reacts as ONE system) ----------------------------
  const smileK = remap(avg('mouthSmile'), 0.25, 0.7);
  const jawRaw = g('jawOpen');
  const jaw = remap(jawRaw, 0.05, 0.72);                    // talking ~0.1-0.35, shouting 0.6-0.8
  const browUpAvg = remap(avg('browOuterUp'), 0.08, 0.5);
  const innerUp = remap(g('browInnerUp'), 0.12, 0.65);
  const wideAvg = remap(avg('eyeWide'), 0.08, 0.55);
  const downAvg = remap(avg('browDown'), 0.08, 0.5);
  const surprise = clamp01(wideAvg * 0.55 + browUpAvg * 0.45 + jaw * 0.35 - smileK * 0.4 - downAvg * 0.5);
  const fear = clamp01(innerUp * 0.6 + wideAvg * 0.6 - smileK * 0.8 - jaw * 0.2);
  const laugh = clamp01(smileK * jaw * 1.6);
  const anger = clamp01(downAvg * 1.1 - smileK * 0.5);

  for (const side of ['Left', 'Right']) {
    const s = A[side];
    // ---- eyes -------------------------------------------------------------------------------
    const blinkRaw = g('eyeBlink' + side);
    const blink = remap(blinkRaw, 0.48, 0.78);                       // only a (nearly) closed eye blinks
    const halfLid = smoothstep(0.16, 0.48, blinkRaw) * (1 - blink);  // partial closure = heavy, sarcastic lid
    const wideS = remap(g('eyeWide' + side), 0.08, 0.55) * (1 - blink);
    const squintRaw = remap(g('eyeSquint' + side), 0.3, 0.85) * (1 - blink);
    const down = remap(g('browDown' + side), 0.08, 0.5);
    const outerUp = remap(g('browOuterUp' + side), 0.08, 0.5);
    const frownS = remap(g('mouthFrown' + side) + g('mouthPress' + side) * 0.3, 0.05, 0.4);
    const happy = clamp01((remap(g('cheekSquint' + side) + g('eyeSquint' + side) * 0.5, 0.2, 0.7) * smileK * 1.2 + laugh * 0.6));
    w['eyeHappy_' + s] = clamp01(happy * eI) * (1 - blink * 0.5);
    w['eyeBlink_' + s] = clamp01(blink * (1 - w['eyeHappy_' + s]));
    w['eyeHalfLid_' + s] = clamp01(halfLid * eI * (1 - w['eyeHappy_' + s]));
    const big = smoothstep(0.35, 0.95, wideS * 0.75 + surprise * 0.65) * (1 - w['eyeHappy_' + s]);
    w['eyeBig_' + s] = clamp01(big * eI);
    w['eyeWide_' + s] = clamp01(wideS * eI * 1.1 * (1 - big)) * (1 - w['eyeHappy_' + s]);
    w['eyeTall_' + s] = clamp01(smoothstep(0.3, 0.85, fear) * (1 - big) * eI * 0.9);
    // squinting WITHOUT smiling narrows into a suspicious slit; with a smile it is the happy squint
    const slit = squintRaw * (1 - smileK);
    w['eyeFlat_' + s] = clamp01(smoothstep(0.45, 0.95, slit) * eI * (1 - anger));
    w['eyeSquint_' + s] = clamp01((squintRaw * (1 - smoothstep(0.45, 0.95, slit)) + anger * 0.35) * eI * Math.max(0, 1 - 2.5 * w['eyeHappy_' + s]));
    w['eyeAngry_' + s] = clamp01(remap(down, 0.1, 0.6) * (1 - smileK * 0.7) * eI);
    w['eyeDroop_' + s] = clamp01(remap(innerUp * 0.7 + frownS * 0.6, 0.25, 0.8) * (1 - smileK) * (1 - big) * eI);
    // ---- brows ------------------------------------------------------------------------------
    w['browUp_' + s] = clamp01((outerUp * 0.85 + big * 0.55) * bI);
    w['browOuterUp_' + s] = clamp01(outerUp * 0.3 * bI);
    w['browDown_' + s] = clamp01(down * bI * (1 - outerUp) * (1 - 0.6 * blink));
    // ---- mouth corners and sections ---------------------------------------------------------
    w['mouthSmile_' + s] = clamp01(remap(g('mouthSmile' + side), 0.12, 0.6) * mI);
    w['mouthFrown_' + s] = clamp01(frownS * mI);
    w['mouthUpper_' + s] = clamp01((remap(g('mouthUpperUp' + side), 0.12, 0.55) * 0.8 + jaw * 0.25 * (side === 'Left' ? 0.8 : 1.0)) * (1 - smileK * 0.6) * mI);
    const shift = remap(g('mouth' + side), 0.12, 0.6);
    w['mouthTilt_' + s] = clamp01(shift * (0.55 + 0.45 * remap(g('mouthSmile' + side) + jawRaw, 0.1, 0.6)) * mI);
  }
  // skeptical / sarcastic: one brow up, the other not -> arch the raised brow, half-lid the other eye
  const asym = remap(g('browOuterUpLeft'), 0.08, 0.5) - remap(g('browOuterUpRight'), 0.08, 0.5);
  if (Math.abs(asym) > 0.15) {
    const up = asym > 0 ? A.Left : A.Right, other = asym > 0 ? A.Right : A.Left, k = smoothstep(0.15, 0.6, Math.abs(asym));
    w['browArch_' + up] = clamp01(k * bI);
    w['eyeHalfLid_' + other] = clamp01(Math.max(w['eyeHalfLid_' + other], k * 0.55 * eI));
  }
  w.browInnerUp = clamp01((innerUp + fear * 0.3) * bI);
  // ---- jaw / mouth body ------------------------------------------------------------------------
  w.jawOpen = clamp01((jaw + smileK * 0.08) * mI);
  // black interior: only a REALLY open mouth, more for shouting / strong surprise / laughing,
  // smooth and non-linear (normal talking never shows it); smiles favour rainbow over black
  const shout = clamp01(anger * jaw * 1.5);
  const cue = Math.max(surprise, laugh, shout);
  w.mouthInterior = clamp01(smoothstep(0.42, 0.85, jawRaw) * (0.45 + 0.55 * cue) * (1 - 0.45 * smileK * (1 - laugh)) * mI);
  w.mouthCenterUp = clamp01((remap(g('mouthShrugUpper'), 0.1, 0.5) * 0.7 + remap(g('mouthFunnel'), 0.08, 0.4) * 0.4 + jaw * 0.3) * (1 - smileK) * mI);
  w.mouthPucker = clamp01(Math.max(remap(g('mouthPucker'), 0.25, 0.85), remap(g('mouthFunnel'), 0.1, 0.5)) * mI * (1 - smileK));
  w.mouthWave = clamp01((smoothstep(0.25, 0.8, fear) * 0.9 + remap(avg('mouthStretch'), 0.2, 0.6) * 0.35 * (1 - smileK)) * mI);
  const upperUp = avg('mouthUpperUp'), stretch = avg('mouthStretch');
  w.mouthGrit = clamp01((remap(upperUp, 0.25, 0.65) * 0.6 + remap(stretch, 0.15, 0.5) * 0.5 + anger * 0.5) * (1 - jaw * 0.5) * (1 - smileK) * mI);

  // ---- gaze (pupils) ---------------------------------------------------------------------------
  const userLeft = (g('eyeLookOutLeft') + g('eyeLookInRight')) / 2 - (g('eyeLookInLeft') + g('eyeLookOutRight')) / 2;
  const up = avg('eyeLookUp') - avg('eyeLookDown');
  const closed = Math.max(w.eyeBlink_L, w.eyeBlink_R, w.eyeHappy_L, w.eyeHappy_R);
  const gz = T.gaze * 1.3 * (1 - closed) ** 2;
  const dead = (v, d = 0.12) => (Math.abs(v) < d ? 0 : v - Math.sign(v) * d);
  const h = dead(mirror ? -userLeft : userLeft) * gz;
  w.lookLeft = clamp01(h); w.lookRight = clamp01(-h);
  const v = dead(up - 0.05, 0.1);
  w.lookUp = clamp01(v * gz); w.lookDown = clamp01(-v * gz * 0.8);
  const narrowing = clamp01(Math.max(...['L', 'R'].map((s) => w['eyeSquint_' + s] + w['eyeBlink_' + s] + w['eyeHalfLid_' + s] + w['eyeFlat_' + s] + w['eyeAngry_' + s] * 0.5), w.eyeHappy_L, w.eyeHappy_R));
  w.lookDown *= (1 - narrowing) ** 2; w.lookUp *= (1 - narrowing) ** 2;
  const horiz = clamp01(Math.max(w.eyeTall_L, w.eyeTall_R));      // tall narrow eyes leave little room sideways
  w.lookLeft *= 1 - 0.7 * horiz; w.lookRight *= 1 - 0.7 * horiz;
  w.pupilSmall = clamp01(smoothstep(0.3, 0.9, Math.max(fear, wideAvg)) * 0.8 * (1 - Math.max(w.eyeBig_L, w.eyeBig_R)));

  // ---- consistency: lid shapes stack linearly; never close an eye more than fully ---------------
  for (const s of ['L', 'R']) {
    const lid = () => w['eyeBlink_' + s] + w['eyeHappy_' + s] + 0.9 * w['eyeSquint_' + s] + 1.0 * w['eyeHalfLid_' + s] + 0.7 * w['eyeFlat_' + s] + 0.4 * w['eyeAngry_' + s] + 0.3 * w['eyeDroop_' + s];
    let ex = lid() - 1;
    for (const k of ['eyeFlat_', 'eyeSquint_', 'eyeHalfLid_', 'eyeDroop_', 'eyeAngry_']) {
      if (ex <= 0) break;
      const coef = { eyeFlat_: 0.7, eyeSquint_: 0.9, eyeHalfLid_: 1.0, eyeDroop_: 0.3, eyeAngry_: 0.4 }[k];
      const cut = Math.min(w[k + s], ex / coef); w[k + s] -= cut; ex -= cut * coef;
    }
    // opening shapes fight closing ones: a closing eye cannot also be big / wide / tall
    const closing = clamp01(w['eyeBlink_' + s] + w['eyeHappy_' + s] + w['eyeHalfLid_' + s] * 0.7 + w['eyeFlat_' + s]);
    for (const k of ['eyeBig_', 'eyeWide_', 'eyeTall_']) w[k + s] *= 1 - closing;
    // pupil-scale shapes add linearly: total shrink must stay below 100 %
    const room = 0.97 - 0.98 * (w['eyeBlink_' + s] + w['eyeHappy_' + s]) - 0.2 * w['eyeSquint_' + s] - 0.58 * w['eyeBig_' + s] - 0.35 * w['eyeTall_' + s];
    w.pupilSmall = Math.min(w.pupilSmall, Math.max(0, room / 0.5));
  }
  const tl = w.mouthTilt_L, tr = w.mouthTilt_R;
  w.mouthTilt_L = clamp01(tl - tr); w.mouthTilt_R = clamp01(tr - tl);

  const furious = clamp01(Math.min(remap(g('browDownLeft'), 0.08, 0.5), remap(g('browDownRight'), 0.08, 0.5)) * 1.1 - smileK * 0.5);   // BOTH brows down
  const red = T.autoMoodColor ? clamp01(smoothstep(0.5, 0.9, furious) * clamp01(w.mouthGrit + w.jawOpen * 0.8)) : 0;
  return { weights: w, mood: { red, green: 0 } };
}

/** blendshape array from FaceLandmarker result -> {name: score} */
export function categoriesToDict(categories) {
  const d = {};
  for (const c of categories) d[c.categoryName] = c.score;
  return d;
}
