// Temporal filtering of the face weights (pure; shared by avatar.js and the replay tests).
//  * One-Euro filters: little jitter when still, little lag when moving fast
//  * responsiveness setting scales every filter; low tracking confidence smooths more
//  * cartoon "pop": a slightly under-damped spring on the big shapes (eyes/brows/jaw) so fast onsets
//    overshoot a touch, like hand-animated key poses (ZAMination style)
export class OneEuro {
  constructor(minCutoff = 1.2, beta = 4, dCutoff = 1.0) { Object.assign(this, { minCutoff, beta, dCutoff }); this.x = null; this.dx = 0; }
  static a(dt, c) { const r = 2 * Math.PI * c * dt; return r / (r + 1); }
  filter(v, dt, scale = 1) {
    if (this.x === null) { this.x = v; return v; }
    const dx = (v - this.x) / dt;
    this.dx += OneEuro.a(dt, this.dCutoff) * (dx - this.dx);
    const c = (this.minCutoff + this.beta * Math.abs(this.dx)) * scale;
    this.x += OneEuro.a(dt, c) * (v - this.x);
    return this.x;
  }
}
const POP = /^(eyeBig|eyeTall|browUp|browInnerUp|jawOpen|pupilSmall|mouthInterior)/;
const params = (g) => (g.startsWith('eyeBlink') ? [4, 30] : g.startsWith('look') ? [1.5, 8]
  : /^(jaw|mouth)/.test(g) ? [1.8, 9] : g.startsWith('brow') ? [1.8, 9] : [2.0, 10]);

export class FaceSmoother {
  constructor() { this.reset(); }
  reset() { this.filters = {}; this.cur = {}; this.vel = {}; this.blinkTimer = 2; this.idleBlink = 0; }
  /** target: {group: w} or null (face lost -> relax + idle blinks). Returns smoothed weights. */
  step(groups, target, dt, { responsiveness = 1, conf = 1, pop = 0 } = {}) {
    dt = Math.max(1e-3, Math.min(0.1, dt));
    const out = {};
    let tgt = target;
    if (!target) {
      tgt = {};
      this.blinkTimer -= dt;
      if (this.blinkTimer < 0) { this.idleBlink = 0.12; this.blinkTimer = 2.5 + Math.random() * 2.5; }
      if (this.idleBlink > 0) { this.idleBlink -= dt; tgt.eyeBlink_L = tgt.eyeBlink_R = 1; }
    }
    const scale = responsiveness * (0.55 + 0.45 * conf);
    for (const g of groups) {
      const goal = tgt[g] ?? 0;
      let v;
      if (!target) {          // relax toward rest at a fixed pace
        const c = this.cur[g] ?? 0; v = c + (goal - c) * Math.min(1, dt * (g.startsWith('eyeBlink') ? 30 : 4));
        if (this.filters[g]) this.filters[g].x = v; this.vel[g] = 0;
      } else if (pop > 0 && POP.test(g)) {
        // spring: omega ~ 5.5 Hz * responsiveness, damping ratio 1 - 2.2*pop (0.22 -> ~15 % overshoot)
        const w = 2 * Math.PI * 5.5 * responsiveness, z = Math.max(0.35, 1 - 2.2 * pop);
        let x = this.cur[g] ?? goal, u = this.vel[g] ?? 0;
        const n = Math.ceil(dt / (1 / 240));
        for (let i = 0; i < n; i++) { const h = dt / n; u += (w * w * (goal - x) - 2 * z * w * u) * h; x += u * h; }
        this.vel[g] = u; v = x;
        if (this.filters[g]) this.filters[g].x = v;
      } else {
        const f = (this.filters[g] ||= new OneEuro(...params(g)));
        v = f.filter(goal, dt, g.startsWith('eyeBlink') ? 1 : scale);
      }
      this.cur[g] = v;
      out[g] = Math.max(0, Math.min(1, v));
    }
    return out;
  }
}
