// Quick expression buttons: one-tap ZAMination faces blended over the tracked face.
// Tap = play for ~1.3 s, press and hold = keep it while held. Keys 1-6 do the same on a keyboard.
// Weights are avatar shapes (both sides unless noted); `mood` drives the screen effects. The face
// constraints still run afterwards, so a pose can never push the mouth into the eyes etc.
const both = (k, v) => ({ [k + '_L']: v, [k + '_R']: v });

export const POSES = [
  { id: 'rage', icon: '😡', label: 'Rage',
    w: { ...both('eyeAngry', 0.9), ...both('eyeSquint', 0.2), ...both('browDown', 1), browPinch: 0.7, pupilSmall: 0.5,
      jawOpen: 0.7, mouthInterior: 0.75, mouthGrit: 0.9, ...both('mouthUpper', 0.45), ...both('mouthFrown', 0.3) },
    mood: { red: 1, furrow: 1, shadeL: 0.3, shadeR: 0.3 } },
  { id: 'shock', icon: '😱', label: 'Shock',
    w: { ...both('eyeBig', 1), ...both('eyeTall', 0.7), pupilSmall: 1, ...both('browUp', 1), ...both('browOuterUp', 0.4),
      jawOpen: 0.95, mouthInterior: 0.9, mouthRound: 0.35, mouthWave: 0.5 },
    mood: {}, glitch: 0.35 },
  { id: 'stare', icon: '😑', label: 'Stare',
    w: { ...both('eyeHalfLid', 0.75), ...both('eyeFlat', 0.5), pupilSmall: 0.7, ...both('browFlat', 1), ...both('mouthFrown', 0.12) },
    mood: { shadeL: 0.75, shadeR: 0.75 } },
  { id: 'smug', icon: '😏', label: 'Smug',
    w: { ...both('eyeHalfLid', 0.45), browArch_L: 0.9, browDown_R: 0.5, mouthSmile_L: 0.9, mouthSmile_R: 0.1, mouthTilt_L: 0.55, lookLeft: 0.4 },
    mood: { shadeR: 0.3 } },
  { id: 'joy', icon: '😄', label: 'Joy',
    w: { ...both('eyeHappy', 1), ...both('browUp', 0.5), ...both('mouthSmile', 1), jawOpen: 0.55, mouthInterior: 0.45 },
    mood: {} },
  { id: 'worry', icon: '😟', label: 'Worry',
    w: { ...both('browWorry', 1), browInnerUp: 0.7, ...both('eyeDroop', 0.4), ...both('eyeTall', 0.3), pupilSmall: 0.4, ...both('mouthFrown', 0.6), mouthWave: 0.6, jawOpen: 0.15 },
    mood: { shadeL: 0.35, shadeR: 0.35 } },
];

const TAP = 0.35, PLAY = 1.3;    // a press shorter than TAP s plays the pose for PLAY s

export class PosePlayer {
  constructor() { this.pose = null; this.k = 0; this.target = 0; this.t = 0; this.downAt = 0; this.until = 0; this.glitch = 0; }
  get active() { return this.k > 0.01 || this.target > 0; }
  press(id) {
    const p = POSES.find((x) => x.id === id); if (!p) return;
    if (this.pose !== p) this.glitch = p.glitch || 0;             // a little static as shock hits
    this.pose = p; this.target = 1; this.downAt = this.t; this.until = 0;
  }
  release() {
    if (!this.pose || this.target === 0) return;
    if (this.t - this.downAt < TAP) this.until = this.downAt + PLAY; else this.target = 0;
  }
  step(dt) {
    this.t += dt;
    if (this.until && this.t >= this.until) { this.target = 0; this.until = 0; }
    // snap in (cartoon pop), ease out
    const rate = this.target > this.k ? 14 : 5;
    this.k += (this.target - this.k) * Math.min(1, dt * rate);
    if (this.target === 0 && this.k < 0.005) { this.k = 0; this.pose = null; }
    this.glitch = Math.max(0, this.glitch - dt * 1.8);
    return this.k;
  }
  /** blend the pose over the face weights (groups not in the pose relax towards 0; gaze keeps tracking) */
  apply(w) {
    if (!this.pose || this.k <= 0) return w;
    const k = this.k, pw = this.pose.w;
    for (const g in w) {
      if (/^look|^eyeCorrect/.test(g) && !(g in pw)) continue;
      w[g] += ((pw[g] || 0) - w[g]) * k;
    }
    return w;
  }
  /** blend the pose's screen mood over the tracked one */
  mood(m) {
    if (!this.pose || this.k <= 0) return m;
    const out = { ...m }, pm = this.pose.mood, k = this.k;
    for (const key of ['shadeL', 'shadeR', 'green', 'furrow', 'red']) out[key] = (m[key] || 0) + ((pm[key] || 0) - (m[key] || 0)) * k;
    return out;
  }
}
