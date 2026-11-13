// Maps MediaPipe FaceLandmarker signals to Mr. Puzzles' own morph groups.
// Pure functions: no DOM, no three.js (unit-testable in node). The stateful parts (per-person baselines,
// hysteresis, red flash, confidence) live in face-driver.js, which calls mapFace().
//
// Inputs per frame:
//   bs    : the 52 blendshape scores, already baseline-corrected by the driver (or raw in unit tests)
//   geom  : optional landmark-geometry DELTAS from the person's own neutral (see face-geom.js / driver).
//           They fix what the blendshapes get wrong on real footage (tests/signals/*, docs/REPORT.md):
//           one-sided smiles barely move mouthSmile; eyeWide stays < 0.1 even in shock; squinting raises
//           browDown; screaming / grimacing reads as a big smile.
//
// Side convention (default, mirror:false): the avatar copies you like a puppet facing you - YOUR left
// eye / brow / mouth corner drives HIS left, exactly like the head rotation (Kalidokit on the unmirrored
// camera image). mirror:true flips face AND head together (selfie mirror). MediaPipe's Left/Right are the
// subject's own sides (verified on tests/signals/20832: the closed eye is landmark 263 = eyeBlinkLeft).

export const AVATAR_GROUPS = [
  'eyeBlink_L', 'eyeBlink_R', 'eyeWide_L', 'eyeWide_R', 'eyeSquint_L', 'eyeSquint_R', 'eyeHappy_L', 'eyeHappy_R',
  'eyeBig_L', 'eyeBig_R', 'eyeTall_L', 'eyeTall_R', 'eyeFlat_L', 'eyeFlat_R', 'eyeHalfLid_L', 'eyeHalfLid_R',
  'eyeDroop_L', 'eyeDroop_R', 'eyeAngry_L', 'eyeAngry_R', 'eyeStretch_L', 'eyeStretch_R',
  'eyeRotOut_L', 'eyeRotOut_R', 'eyeRotIn_L', 'eyeRotIn_R',
  'browUp_L', 'browUp_R', 'browDown_L', 'browDown_R', 'browOuterUp_L', 'browOuterUp_R', 'browArch_L', 'browArch_R', 'browInnerUp',
  'lookLeft', 'lookRight', 'lookUp', 'lookDown', 'pupilSmall', 'pupilBig',
  'jawOpen', 'mouthInterior', 'mouthSmile_L', 'mouthSmile_R', 'mouthFrown_L', 'mouthFrown_R', 'mouthUpper_L', 'mouthUpper_R',
  'mouthRound', 'mouthCenterUp', 'mouthWave', 'mouthPucker', 'mouthGrit', 'mouthTilt_L', 'mouthTilt_R', 'eyeCorrect_L', 'eyeCorrect_R',
];
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
// linear remap of [lo,hi] -> [0,1] with a gentle ease so small noise near lo is suppressed
export const remap = (v, lo, hi) => {
  const t = clamp01((v - lo) / (hi - lo));
  return t * t * (3 - 2 * t) * 0.35 + t * 0.65;
};

// Tracking styles change how signals are INTERPRETED, not just their gain:
//   curve : pose-to-pose shaping (0 = follow the signal linearly, 1 = snap into strong cartoon poses)
//   coord : how much features drive each other (smile squints the eyes, surprise lifts the brows, ...)
//   asym  : exaggeration of left/right differences (smirks, one raised brow, winks)
//   eyeDyn: dynamic eye size (huge surprise eyes, tall fear ovals, stretched tired eyes)
//   open  : jaw opening needed before the black mouth interior appears (higher = rarer)
//   pop   : overshoot on fast onsets (applied by avatar.js)
export const STYLES = {
  accurate: { gain: 0.9, curve: 0.0, coord: 0.15, asym: 0.0, eyeDyn: 0.3, open: 0.6, pop: 0.0 },
  balanced: { gain: 1.0, curve: 0.45, coord: 0.6, asym: 0.5, eyeDyn: 0.7, open: 0.5, pop: 0.1 },
  zamination: { gain: 1.15, curve: 1.0, coord: 1.0, asym: 1.0, eyeDyn: 1.0, open: 0.44, pop: 0.22 },
};

export const DEFAULT_TUNING = {
  style: 'zamination',
  intensity: 1.0,      // expressiveness (scales the style)
  eyeIntensity: 1.0,   // eye exaggeration
  mouthIntensity: 1.0, // mouth exaggeration
  browIntensity: 1.0,
  gaze: 1.0,
  responsiveness: 1.0, // smoothing vs. speed (avatar.js)
  autoMoodColor: true, // red flash on sudden anger / shouting
  greenFx: false,      // sickly green gradient on disgust (optional)
  shading: 1.0,        // dynamic purple-grey upper-screen shading (0 = off)
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

/** Per-side primitive signals (subject's sides) from blendshapes + optional geometry deltas. */
export function signals(b, geom) {
  const g = (k) => b[k] ?? 0;
  const G = (k) => (geom ? geom[k] ?? 0 : 0);
  const side = {};
  for (const X of ['Left', 'Right']) {
    const blinkRaw = Math.max(g('eyeBlink' + X), geom ? smoothstep(-0.45, -0.8, G('eyeOpen' + X)) : 0);
    const open = G('eyeOpen' + X);                       // relative change of the lid gap (+0.3 = 30 % wider)
    const smile = Math.max(remap(g('mouthSmile' + X), 0.12, 0.75), smoothstep(0.025, 0.1, G('corner' + X)));
    side[X] = {
      blinkRaw,
      // narrowing without closing: lower lid up (eyeSquint) or a smaller lid gap
      squint: Math.max(remap(g('eyeSquint' + X), 0.12, 0.55), smoothstep(0.08, 0.45, -open) * (1 - smoothstep(0.5, 0.8, blinkRaw))),
      wide: Math.max(remap(g('eyeWide' + X), 0.04, 0.4), smoothstep(0.12, 0.5, open)),
      browUp: Math.max(remap(g('browOuterUp' + X), 0.08, 0.45), smoothstep(0.012, 0.085, G('browMid' + X))),
      browOuter: Math.max(remap(g('browOuterUp' + X), 0.08, 0.45), smoothstep(0.012, 0.08, G('browOuter' + X))),
      // a squinting grin shortens the brow-eye distance too (cheeks push the eye up): discount geometry
      browDown: Math.max(remap(g('browDown' + X), 0.1, 0.5), smoothstep(0.012, 0.09, -G('browMid' + X)) * (1 - 0.8 * smile)),
      innerUp: smoothstep(0.012, 0.07, G('browInner' + X) - 0.5 * Math.max(0, G('browOuter' + X))),
      smile,
      frown: Math.max(remap(g('mouthFrown' + X) + g('mouthPress' + X) * 0.3, 0.05, 0.4), smoothstep(0.025, 0.08, -G('corner' + X))),
      browDownHard: smoothstep(0.55, 0.85, g('browDown' + X)),   // only a hard frown (grimace), never a grin's squint
      upperUp: remap(g('mouthUpperUp' + X), 0.15, 0.6),
      stretch: remap(g('mouthStretch' + X), 0.12, 0.5),
      press: remap(g('mouthPress' + X), 0.12, 0.5),
      shift: Math.max(remap(g('mouth' + X), 0.1, 0.55), smoothstep(0.02, 0.1, (X === 'Left' ? 1 : -1) * G('mouthShift'))),
    };
  }
  const jaw = Math.max(remap(g('jawOpen'), 0.04, 0.62), smoothstep(0.04, 0.55, G('mouthOpen')));
  const narrow = geom ? smoothstep(-0.02, -0.14, G('mouthWidth')) : 0.6;     // lips drawn together
  return {
    side, jaw,
    innerUp: Math.max(remap(g('browInnerUp'), 0.12, 0.6), (side.Left.innerUp + side.Right.innerUp) / 2),
    round: clamp01(Math.max(remap(g('mouthPucker'), 0.3, 0.85), remap(g('mouthFunnel'), 0.1, 0.45)) * (0.4 + 0.6 * narrow)),
    shrug: remap(g('mouthShrugUpper'), 0.1, 0.5),
  };
}

/**
 * @param {Object<string,number>} bsRaw  blendshape name -> score
 * @param {Object} opts {mirror, neutral, tuning, geom, conf}
 * @returns {{weights:Object<string,number>, mood:{red, green, anger, shade, shadeL, shadeR}, cues:Object}}
 */
export function mapFace(bsRaw, { mirror = false, neutral = null, tuning = DEFAULT_TUNING, geom = null, conf = 1 } = {}) {
  const b = calibrated(bsRaw, neutral);
  const T = { ...DEFAULT_TUNING, ...tuning };
  const St = STYLES[T.style] || STYLES.zamination;
  const I = T.intensity, eI = I * T.eyeIntensity, bI = I * T.browIntensity, mI = I * T.mouthIntensity;
  const co = St.coord * Math.min(1.3, I), dyn = St.eyeDyn;
  // pose-to-pose shaping (ZAMination snaps into strong poses; Accurate stays linear)
  const P = (x, lo = 0.06, hi = 0.7) => clamp01(lerp(x, smoothstep(lo, hi, x), St.curve) * St.gain);
  const A = mirror ? { Left: 'R', Right: 'L' } : { Left: 'L', Right: 'R' };   // user side -> avatar side
  const w = Object.fromEntries(AVATAR_GROUPS.map((n) => [n, 0]));
  const S = signals(b, geom);
  // low confidence (head turned away): the far side's signals are unreliable -> pull sides together
  const k = clamp01(conf);
  for (const key of Object.keys(S.side.Left)) {
    const m = (S.side.Left[key] + S.side.Right[key]) / 2;
    S.side.Left[key] = lerp(m, S.side.Left[key], k); S.side.Right[key] = lerp(m, S.side.Right[key], k);
  }
  const avg = (key) => (S.side.Left[key] + S.side.Right[key]) / 2;
  const mx = (key) => Math.max(S.side.Left[key], S.side.Right[key]);

  // ---- global cues: the face reacts as ONE system, but no single movement means one emotion --------
  const smileK = avg('smile'), jaw = S.jaw, innerUp = S.innerUp;
  const browDn = avg('browDown'), browUp = avg('browUp'), wide = avg('wide'), squint = avg('squint');
  // anger needs lowered brows AND a tense / open mouth; lowered brows + squint alone = focus / suspicion
  // On a smiling face only an OPEN jaw counts as tension (scream / roar); a squinting grin also pulls the
  // brows down a little, so that is discounted (tests/signals: 2749 grin vs 42242 scream vs 47501 grimace)
  const unsmile = 1 - smileK;
  // clenched grimace: 'smile' + raised upper lip + brows hard down (47501) is tension, a grin is not
  const grimace = smileK * avg('upperUp') * avg('browDownHard');
  const tension = Math.max(avg('upperUp') * unsmile * (0.4 + 0.6 * browDn), avg('press') * unsmile, avg('stretch') * 0.8 * unsmile, jaw * 0.9, grimace);
  const browDnA = browDn * (1 - 0.55 * smileK * (1 - jaw) * (1 - grimace));
  const anger = clamp01(smoothstep(0.3, 0.75, browDnA) * smoothstep(0.15, 0.55, tension) * (1 - 0.5 * browUp));
  const scream = clamp01(anger * smoothstep(0.35, 0.8, jaw));
  const laugh = clamp01(smileK * smoothstep(0.15, 0.6, jaw) * (1 - smoothstep(0.35, 0.75, browDn)));
  // surprise needs raised brows AND open eyes together (talking alone moves either a little)
  const surprise = clamp01(Math.max(Math.min(browUp, wide) * 1.1 + browUp * 0.25 + wide * 0.15, smoothstep(0.35, 0.9, browUp) * 0.75) + jaw * 0.2 * browUp - browDn * 0.8 - smileK * 0.3);
  const fear = clamp01(Math.min(innerUp, wide) * 1.1 + innerUp * 0.2 + avg('stretch') * 0.25 * wide - smileK * 0.9 - jaw * 0.15 - browDn * 0.3);
  const sad = clamp01(innerUp * 0.45 + avg('frown') * 0.6 - smileK - wide * 0.4 - jaw * 0.3);
  const disgust = clamp01(avg('upperUp') * (1 - smileK) * 1.1 * (1 - anger) + (mx('upperUp') - Math.min(S.side.Left.upperUp, S.side.Right.upperUp)) * 0.4 * (1 - smileK));
  const suspicion = clamp01(smoothstep(0.2, 0.6, squint) * (0.4 + 0.6 * browDn) * (1 - smileK) * (1 - anger) * (1 - jaw));
  const halfBoth = Math.min(...['Left', 'Right'].map((X) => smoothstep(0.12, 0.45, S.side[X].blinkRaw) * (1 - smoothstep(0.55, 0.8, S.side[X].blinkRaw))));
  const tired = clamp01(halfBoth * (1 - smileK) * (1 - browUp));
  // exaggerate left/right differences for the per-side features only (smirks, one brow, uneven squints);
  // the global cues above use the real values
  for (const key of ['smile', 'frown', 'browUp', 'browDown', 'squint', 'upperUp']) {
    const L = S.side.Left[key], R = S.side.Right[key], m = (L + R) / 2;
    const e = 1 + St.asym * k;      // a turned head fakes asymmetry: exaggerate only what is reliable
    S.side.Left[key] = clamp01(m + (L - m) * e); S.side.Right[key] = clamp01(m + (R - m) * e);
  }

  for (const X of ['Left', 'Right']) {
    const s = A[X], x = S.side[X];
    // ---- eyes -------------------------------------------------------------------------------------
    const blink = remap(x.blinkRaw, 0.45, 0.78);
    const half = smoothstep(0.12, 0.45, x.blinkRaw) * (1 - blink);
    const happy = clamp01(smoothstep(0.3, 0.75, x.squint * (0.75 + 0.25 * co) + x.smile * 0.25 + laugh * 0.15 * co) * smoothstep(0.25, 0.6, x.smile) * (1 - anger) * (1 - smoothstep(0.25, 0.6, browDn)));
    w['eyeHappy_' + s] = clamp01(P(happy) * eI) * (1 - blink * 0.5);
    w['eyeBlink_' + s] = clamp01(blink * (1 - w['eyeHappy_' + s]));
    w['eyeHalfLid_' + s] = clamp01((P(half) + (tired * 0.4 + disgust * 0.45 + suspicion * 0.25) * co) * eI * (1 - w['eyeHappy_' + s]));
    // dynamic size: eyes expand into the free screen space for surprise / alarm (never just because the
    // mouth is closed)
    const big = smoothstep(0.42, 0.95, (x.wide * 0.6 + surprise * 0.7) * (0.55 + 0.45 * dyn) + (dyn - 1) * 0.15) * (1 - w['eyeHappy_' + s]);
    w['eyeBig_' + s] = clamp01(big * eI * (0.5 + 0.5 * dyn));
    w['eyeWide_' + s] = clamp01(P(x.wide) * eI * 1.1 * (1 - big)) * (1 - w['eyeHappy_' + s]);
    w['eyeTall_' + s] = clamp01(smoothstep(0.25, 0.8, fear) * (1 - big) * eI * dyn);
    // squinting without smiling narrows into a suspicious slit; with a smile it is the happy squint
    const slit = x.squint * (1 - smileK);
    w['eyeFlat_' + s] = clamp01(smoothstep(0.45, 0.95, slit) * eI * (1 - anger) * (0.5 + 0.5 * co));
    w['eyeSquint_' + s] = clamp01((P(x.squint) * (1 - smoothstep(0.45, 0.95, slit) * 0.6) + anger * 0.3 * co) * eI * Math.max(0, 1 - 2.5 * w['eyeHappy_' + s]));
    w['eyeAngry_' + s] = clamp01((anger * 0.85 + x.browDown * 0.2 * co * (1 - smileK)) * eI);
    w['eyeDroop_' + s] = clamp01(smoothstep(0.15, 0.6, sad + tired * 0.4 * co) * (1 - big) * eI);
    // tired / disgusted ZAMination eyes: horizontally stretched under heavy lids; pleading/sad: outer
    // corners down; sly / furious: outer corners up
    w['eyeStretch_' + s] = clamp01(smoothstep(0.2, 0.7, tired * 0.8 + disgust * 0.6 + sad * 0.3) * dyn * eI);
    w['eyeRotIn_' + s] = clamp01(smoothstep(0.15, 0.6, sad + fear * 0.4) * co * eI);
    const sly = Math.max(0, x.smile - (X === 'Left' ? S.side.Right.smile : S.side.Left.smile));
    w['eyeRotOut_' + s] = clamp01((anger * 0.7 + smoothstep(0.15, 0.5, sly) * 0.5) * co * eI);
    // ---- brows ------------------------------------------------------------------------------------
    w['browUp_' + s] = clamp01((P(x.browUp) * 0.9 + big * 0.5 * co + surprise * 0.2 * co) * bI);
    w['browOuterUp_' + s] = clamp01(x.browOuter * 0.35 * bI);
    w['browDown_' + s] = clamp01((P(x.browDown) + anger * 0.25 * co) * bI * (1 - x.browUp) * (1 - 0.6 * blink));
    // ---- mouth corners and sections ---------------------------------------------------------------
    // a scream / grimace also reads as a 'smile' to the tracker: anger flattens it into a wide open shout
    w['mouthSmile_' + s] = clamp01(P(x.smile, 0.04, 0.6) * mI * (1 - 0.75 * anger));
    w['mouthFrown_' + s] = clamp01(P(x.frown) * mI * (1 - x.smile));
    // one side of the upper lip (sneer / uneven talk) - NOT driven by the jaw any more: speech stays smooth
    const upperSide = clamp01(x.upperUp - Math.min(S.side.Left.upperUp, S.side.Right.upperUp) * 0.6);
    w['mouthUpper_' + s] = clamp01((upperSide * 0.8 + disgust * 0.3) * (1 - smileK * 0.7) * mI);
    w['mouthTilt_' + s] = clamp01((x.shift * (0.55 + 0.45 * jaw) + smoothstep(0.2, 0.55, sly) * 0.35 * co) * mI);
  }
  // one raised brow (skeptical / sarcastic): arch it. Only in strong styles is the other eye pulled
  // slightly heavier; tracked lids always win, so any combination stays possible.
  const dUp = S.side.Left.browUp - S.side.Right.browUp;
  if (Math.abs(dUp) > 0.12) {
    const up = dUp > 0 ? A.Left : A.Right, other = dUp > 0 ? A.Right : A.Left, kk = smoothstep(0.12, 0.5, Math.abs(dUp));
    w['browArch_' + up] = clamp01(kk * bI);
    w['eyeHalfLid_' + other] = clamp01(Math.max(w['eyeHalfLid_' + other], kk * 0.35 * co * eI));
  }
  w.browInnerUp = clamp01((P(innerUp) + fear * 0.3 * co + sad * 0.25 * co) * bI);
  // ---- jaw / mouth body ------------------------------------------------------------------------------
  w.jawOpen = clamp01((P(jaw, 0.03, 0.75) + smileK * 0.08) * mI);
  // black interior: only a REALLY open mouth (shouting, screaming, laughing, strong surprise);
  // smooth and non-linear, ordinary talking never shows it
  const cue = Math.max(surprise, laugh, scream, fear * 0.6);
  w.mouthInterior = clamp01(smoothstep(St.open, St.open + 0.42, jaw) * (0.4 + 0.6 * cue) * (1 - 0.45 * smileK * (1 - laugh)) * mI);
  // rounded vowels: a soft dome; a strong pucker with a closed jaw becomes the narrow "what?" peak
  const round = S.round * (1 - smileK);
  w.mouthRound = clamp01(P(round) * (0.6 + 0.4 * (1 - smoothstep(0.5, 0.9, round))) * mI);
  w.mouthPucker = clamp01(smoothstep(0.55, 0.95, round) * (1 - jaw) * mI);
  w.mouthCenterUp = clamp01((S.shrug * 0.6 + jaw * 0.25 * (1 - smileK) + surprise * 0.2) * (1 - smileK) * mI);
  w.mouthWave = clamp01((smoothstep(0.25, 0.8, fear) * 0.8 + sad * 0.25) * co * mI);
  // jagged teeth: real anger only (tense lip + lowered brows), never ordinary speech
  w.mouthGrit = clamp01(smoothstep(0.25, 0.75, anger) * (0.5 + 0.5 * Math.max(avg('upperUp'), avg('press'))) * (1 - jaw * 0.4) * co * mI);

  // ---- gaze (pupils) -----------------------------------------------------------------------------------
  const gg = (n) => b[n] ?? 0;
  const userLeft = (gg('eyeLookOutLeft') + gg('eyeLookInRight')) / 2 - (gg('eyeLookInLeft') + gg('eyeLookOutRight')) / 2;
  const up = (gg('eyeLookUpLeft') + gg('eyeLookUpRight')) / 2 - (gg('eyeLookDownLeft') + gg('eyeLookDownRight')) / 2;
  const closed = Math.max(w.eyeBlink_L, w.eyeBlink_R, w.eyeHappy_L, w.eyeHappy_R);
  const gz = T.gaze * 1.3 * (1 - closed) ** 2;
  const dead = (v, d = 0.12) => (Math.abs(v) < d ? 0 : v - Math.sign(v) * d);
  const h = dead(mirror ? -userLeft : userLeft) * gz;
  w.lookLeft = clamp01(h); w.lookRight = clamp01(-h);
  const v = dead(up - 0.05, 0.1);
  w.lookUp = clamp01(v * gz); w.lookDown = clamp01(-v * gz * 0.8);
  const narrowing = clamp01(Math.max(...['L', 'R'].map((s) => w['eyeSquint_' + s] + w['eyeBlink_' + s] + w['eyeHalfLid_' + s] + w['eyeFlat_' + s] + w['eyeAngry_' + s] * 0.5 + w['eyeStretch_' + s] * 0.4), w.eyeHappy_L, w.eyeHappy_R));
  w.lookDown *= (1 - narrowing) ** 2; w.lookUp *= (1 - narrowing) ** 2;
  const horiz = clamp01(Math.max(w.eyeTall_L, w.eyeTall_R));      // tall narrow eyes leave little room sideways
  w.lookLeft *= 1 - 0.7 * horiz; w.lookRight *= 1 - 0.7 * horiz;
  // pupils: pin-points for shock / fear / rage, big soft pupils for sad / pleading
  w.pupilSmall = clamp01(smoothstep(0.3, 0.9, Math.max(fear, surprise * 0.8, anger * 0.7)) * 0.8 * (1 - Math.max(w.eyeBig_L, w.eyeBig_R)) * (0.4 + 0.6 * co));
  w.pupilBig = clamp01(smoothstep(0.2, 0.7, sad) * 0.9 * co * (1 - w.pupilSmall));

  // ---- consistency: lid shapes stack linearly; never close an eye more than fully -----------------------
  for (const s of ['L', 'R']) {
    const coefs = { eyeFlat_: 0.7, eyeSquint_: 0.9, eyeHalfLid_: 1.0, eyeDroop_: 0.3, eyeAngry_: 0.4, eyeStretch_: 0.3 };
    let ex = w['eyeBlink_' + s] + w['eyeHappy_' + s] + Object.entries(coefs).reduce((a, [key, c]) => a + c * w[key + s], 0) - 1;
    for (const key of ['eyeStretch_', 'eyeFlat_', 'eyeSquint_', 'eyeHalfLid_', 'eyeDroop_', 'eyeAngry_']) {
      if (ex <= 0) break;
      const cut = Math.min(w[key + s], ex / coefs[key]); w[key + s] -= cut; ex -= cut * coefs[key];
    }
    // opening shapes fight closing ones: a closing eye cannot also be big / wide / tall
    const closing = clamp01(w['eyeBlink_' + s] + w['eyeHappy_' + s] + w['eyeHalfLid_' + s] * 0.7 + w['eyeFlat_' + s]);
    for (const key of ['eyeBig_', 'eyeWide_', 'eyeTall_']) w[key + s] *= 1 - closing;
    // rotations of the outline: in and out cancel
    const ri = w['eyeRotIn_' + s], ro = w['eyeRotOut_' + s];
    w['eyeRotIn_' + s] = clamp01(ri - ro); w['eyeRotOut_' + s] = clamp01(ro - ri);
    // pupil-scale shapes add linearly: total shrink must stay below 100 %, growth needs room
    const room = 0.97 - 0.98 * (w['eyeBlink_' + s] + w['eyeHappy_' + s]) - 0.2 * w['eyeSquint_' + s] - 0.58 * w['eyeBig_' + s] - 0.35 * w['eyeTall_' + s];
    w.pupilSmall = Math.min(w.pupilSmall, Math.max(0, room / 0.5));
    const lidded = w['eyeBlink_' + s] + w['eyeHappy_' + s] + w['eyeSquint_' + s] + w['eyeHalfLid_' + s] + w['eyeFlat_' + s] + w['eyeStretch_' + s] * 0.5 + w['eyeTall_' + s]
      + w['eyeDroop_' + s] * 0.6 + w['eyeAngry_' + s] * 0.6 + Math.max(w.lookLeft, w.lookRight, w.lookUp, w.lookDown) * 0.5;
    w.pupilBig = Math.min(w.pupilBig, Math.max(0, 1 - lidded * 1.4));
  }
  const tl = w.mouthTilt_L, tr = w.mouthTilt_R;
  w.mouthTilt_L = clamp01(tl - tr); w.mouthTilt_R = clamp01(tr - tl);

  // ---- screen effects (the driver turns `anger` into a brief flash; shading follows the brows) ----------
  const shade = clamp01(Math.max(tired * 0.9, disgust * 0.8, suspicion * 0.6, sad * 0.6, anger * 0.45) * (0.5 + 0.5 * co));
  const sideShade = (s) => clamp01(shade + 0.35 * (w['eyeHalfLid_' + s] + w['browDown_' + s] * 0.5) * co);
  const furious = clamp01(Math.max(anger, scream * 1.2));
  return {
    weights: w,
    mood: { red: 0, green: T.greenFx ? clamp01(smoothstep(0.35, 0.8, disgust) * 0.7) : 0, anger: furious, shade, shadeL: sideShade('L'), shadeR: sideShade('R') },
    cues: { smile: smileK, jaw, anger, scream, laugh, surprise, fear, sad, disgust, suspicion, tired },
  };
}

/** blendshape array from FaceLandmarker result -> {name: score} */
export function categoriesToDict(categories) {
  const d = {};
  for (const c of categories) d[c.categoryName] = c.score;
  return d;
}
