// MediaPipe Face Landmarker blendshapes (ARKit-style names)  ->  the expression names MoodLogic.js uses
// (MoodLogic is shared with the Snapchat Lens project, which uses Lens Studio's expression names).
// Left/Right mean the SUBJECT's left/right in both systems, so no swapping is needed here.
export const MP_TO_LS = {
  browDownLeft: 'BrowsDownLeft', browDownRight: 'BrowsDownRight',
  browInnerUp: 'BrowsUpCenter', browOuterUpLeft: 'BrowsUpLeft', browOuterUpRight: 'BrowsUpRight',
  cheekSquintLeft: 'CheekSquintLeft', cheekSquintRight: 'CheekSquintRight', cheekPuff: 'Puff',
  eyeBlinkLeft: 'EyeBlinkLeft', eyeBlinkRight: 'EyeBlinkRight',
  eyeLookDownLeft: 'EyeDownLeft', eyeLookDownRight: 'EyeDownRight',
  eyeLookInLeft: 'EyeInLeft', eyeLookInRight: 'EyeInRight',
  eyeLookOutLeft: 'EyeOutLeft', eyeLookOutRight: 'EyeOutRight',
  eyeLookUpLeft: 'EyeUpLeft', eyeLookUpRight: 'EyeUpRight',
  eyeSquintLeft: 'EyeSquintLeft', eyeSquintRight: 'EyeSquintRight',
  eyeWideLeft: 'EyeOpenLeft', eyeWideRight: 'EyeOpenRight',
  jawOpen: 'JawOpen', jawForward: 'JawForward', jawLeft: 'JawLeft', jawRight: 'JawRight',
  mouthFunnel: 'LipsFunnel', mouthPucker: 'LipsPucker', mouthClose: 'MouthClose',
  mouthFrownLeft: 'MouthFrownLeft', mouthFrownRight: 'MouthFrownRight',
  mouthLeft: 'MouthLeft', mouthRight: 'MouthRight',
  mouthSmileLeft: 'MouthSmileLeft', mouthSmileRight: 'MouthSmileRight',
  mouthStretchLeft: 'MouthStretchLeft', mouthStretchRight: 'MouthStretchRight',
  mouthPressLeft: 'MouthPressLeft', mouthPressRight: 'MouthPressRight',
  mouthDimpleLeft: 'MouthDimpleLeft', mouthDimpleRight: 'MouthDimpleRight',
  mouthRollLower: 'LowerLipClose', mouthRollUpper: 'UpperLipClose',
  mouthShrugLower: 'LowerLipRaise', mouthShrugUpper: 'UpperLipRaiseShrug',
  mouthUpperUpLeft: 'UpperLipUpLeft', mouthUpperUpRight: 'UpperLipUpRight',
  mouthLowerDownLeft: 'LowerLipDownLeft', mouthLowerDownRight: 'LowerLipDownRight',
  noseSneerLeft: 'SneerLeft', noseSneerRight: 'SneerRight'
};

/** Convert MediaPipe categories -> {LSName: score}. `out` is reused to avoid per-frame allocations. */
export function toLensNames(categories, out) {
  for (let i = 0; i < categories.length; i++) {
    const c = categories[i];
    const ls = MP_TO_LS[c.categoryName];
    if (ls) out[ls] = c.score;
  }
  // MoodLogic's "UpperLipRaise" (disgust lip curl) = the upper-lip-up pair
  out.UpperLipRaise = Math.max(out.UpperLipUpLeft || 0, out.UpperLipUpRight || 0);
  return out;
}

/** Per-channel neutral baseline: v' = (v - base) / (1 - base). Calibrated by averaging ~1 s of the user's relaxed face. */
export class Baseline {
  constructor() { this.base = {}; this.acc = null; this.n = 0; }
  start() { this.acc = {}; this.n = 0; }
  get calibrating() { return this.acc !== null; }
  feed(w) {
    for (const k in w) this.acc[k] = (this.acc[k] || 0) + w[k];
    this.n++;
  }
  finish() {
    const b = {};
    for (const k in this.acc) {
      // only the channels where a relaxed face is "never really zero"; capped so a calibration with a smile cannot kill it
      b[k] = Math.min(0.35, this.acc[k] / Math.max(1, this.n));
    }
    this.base = b; this.acc = null;
    return b;
  }
  reset() { this.base = {}; this.acc = null; }
  apply(w, out) {
    for (const k in w) {
      const b = this.base[k] || 0;
      out[k] = b > 0 ? Math.max(0, (w[k] - b) / (1 - b)) : w[k];
    }
    return out;
  }
}

/**
 * MediaPipe/ARKit blendshapes co-activate in ways Lens Studio's tracker does not: a broad smile (cheek raise) also reports
 * strong brow-down, nose-sneer and upper-lip-up.  Left alone, MoodLogic would read every grin as anger/disgust.
 * So, while the user is smiling, those "cheek side effects" are suppressed (in place).
 */
export function condition(w) {
  const smile = ((w.MouthSmileLeft || 0) + (w.MouthSmileRight || 0)) / 2;
  const sup = Math.min(1, Math.max(0, (smile - 0.12) / 0.45));          // 0 = no smile ... 1 = clear smile
  if (sup > 0) {
    const keepBrow = 1 - 0.92 * sup, keepSneer = 1 - 0.85 * sup, keepLip = 1 - 0.95 * sup;
    w.BrowsDownLeft *= keepBrow; w.BrowsDownRight *= keepBrow;
    w.SneerLeft *= keepSneer; w.SneerRight *= keepSneer;
    w.UpperLipRaise *= keepLip; w.UpperLipUpLeft *= keepLip; w.UpperLipUpRight *= keepLip;
  }
  return w;
}
