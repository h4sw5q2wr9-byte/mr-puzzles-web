// The TV's state: when to show the "Please Stand By" card, the static burst that switches between the
// card and the face (the swap happens at the peak, hidden by the snow), glitches when the head is
// shaken hard, and a rare flicker while standing by. Output goes to screen-fx setTv().
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const BURST = 0.5;          // seconds of static for a switch

export class TvController {
  constructor() { this.reset(); }
  reset(standby = false) {
    this.shown = standby; this.burst = -1; this.shake = 0; this.flick = 0; this.nextFlick = 5; this.time = 0;
  }
  /** want: show the stand-by card; headSpeed: rad/s; opts: {glitches, crt} */
  update(dt, want, headSpeed = 0, { glitches = true, crt = false } = {}) {
    this.time += dt;
    // switch with a static burst
    if (this.burst < 0 && want !== this.shown) this.burst = 0;
    let g = 0;
    if (this.burst >= 0) {
      const t0 = this.burst; this.burst += dt;
      if (t0 < BURST * 0.5 && this.burst >= BURST * 0.5) this.shown = want;       // swap at the peak
      g = Math.pow(Math.sin(Math.PI * Math.min(1, this.burst / BURST)), 0.6);
      if (this.burst >= BURST) this.burst = -1;
    }
    if (glitches) {
      // head shake: the picture tears (the speed of a fast "no" shake is ~4-8 rad/s)
      const target = smoothstep(3.2, 7.5, headSpeed) * 0.75;
      this.shake += (target - this.shake) * Math.min(1, dt * (target > this.shake ? 18 : 5));
      // stand-by: an occasional short flicker, like a weak signal
      if (this.shown) {
        this.nextFlick -= dt;
        if (this.nextFlick < 0) { this.flick = 0.18; this.nextFlick = 4 + Math.random() * 6; }
      }
      this.flick = Math.max(0, this.flick - dt);
    } else { this.shake = 0; this.flick = 0; }
    const flicker = this.flick > 0 ? 0.28 * Math.sin(Math.PI * this.flick / 0.18) : 0;
    return {
      glitch: Math.min(1, Math.max(g, this.shake, flicker)),
      scan: Math.max(crt ? 1 : 0, this.shown ? 0.65 : 0),
      standby: this.shown ? 1 : 0,
      time: this.time,
    };
  }
}
