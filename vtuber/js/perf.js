// Adaptive performance: watches real frame times and tracking times and, if the device keeps
// struggling, lowers the cost step by step; when it is comfortable again for a while, it steps back.
//   healthy    : everything as the user chose
//   struggling : render resolution capped, High -> Medium; if tracking is the bottleneck, the body and
//                hand detectors take turns (each every 2nd frame, last result reused in between)
//   critical   : resolution 1x, quality Low, body / hands every 3rd frame
// Face tracking always runs every frame. The user's own quality choice is never overwritten (only
// capped while needed), and Auto can be switched off. Decisions use 2-second windows that must hold
// for several seconds (hysteresis), and pause while the page is hidden or right after big changes.
const LEVELS = ['healthy', 'struggling', 'critical'];

export class PerfManager {
  constructor() {
    this.state = 'healthy';
    this.frames = [];           // [timestamp ms] of rendered frames (last ~2 s)
    this.track = [];            // [timestamp, ms] tracking cost per processed camera frame
    this.badSince = null; this.worseSince = null; this.goodSince = null;
    this.holdUntil = 0;
    this.longTasks = 0;
    this.listeners = new Set();
  }
  onChange(f) { this.listeners.add(f); }
  /** ignore measurements for a while (mode / quality switch, camera start, model load) */
  hold(ms = 4000) { this.holdUntil = Math.max(this.holdUntil, performance.now() + ms); this.badSince = this.worseSince = this.goodSince = null; }
  frame(now) {
    const last = this.frames[this.frames.length - 1];
    if (last && now - last > 250) this.longTasks++;          // a visible hitch
    this.frames.push(now);
    while (this.frames.length && now - this.frames[0] > 2000) this.frames.shift();
  }
  tracked(now, ms) { this.track.push([now, ms]); while (this.track.length && now - this.track[0][0] > 2000) this.track.shift(); }
  get fps() { const f = this.frames; return f.length > 1 ? ((f.length - 1) * 1000) / (f[f.length - 1] - f[0]) : 0; }
  get trackFps() { const t = this.track; return t.length > 1 ? ((t.length - 1) * 1000) / (t[t.length - 1][0] - t[0][0]) : 0; }
  get trackMs() { const t = this.track; return t.length ? t.reduce((a, x) => a + x[1], 0) / t.length : 0; }

  /** call ~once per second; returns true when the state changed */
  update(now, { tracking }) {
    // judge only a well-filled window (>= 1.5 s of frames; at very low fps that is just a few frames)
    const f = this.frames;
    if (document.hidden || now < this.holdUntil || f.length < 3 || f[f.length - 1] - f[0] < 1500) return false;
    const fps = this.fps, i = LEVELS.indexOf(this.state);
    const bad = fps < 24, worse = fps < 15;
    const good = fps >= 40 && (!tracking || this.trackMs < 25);
    this.badSince = bad ? this.badSince ?? now : null;
    this.worseSince = worse ? this.worseSince ?? now : null;
    this.goodSince = good ? this.goodSince ?? now : null;
    let next = i;
    if (this.worseSince && now - this.worseSince > 4000) next = 2;
    else if (this.badSince && now - this.badSince > 4000) next = Math.max(i, 1);
    else if (this.goodSince && now - this.goodSince > 10000 && i > 0) next = i - 1;
    if (next === i) return false;
    this.state = LEVELS[next];
    this.hold(next > i ? 3000 : 6000);
    this.listeners.forEach((f) => f(this.state));
    return true;
  }

  /** what the app should do now (also used when Auto is off: then everything is 'healthy') */
  plan(auto, { tracking, quality }) {
    const s = auto ? this.state : 'healthy';
    const order = ['low', 'medium', 'high'];
    const cap = s === 'critical' ? 'low' : s === 'struggling' ? 'medium' : 'high';
    const effQuality = order[Math.min(order.indexOf(quality), order.indexOf(cap))];
    // detectors take turns only when tracking is (part of) the problem
    const trackHeavy = tracking && this.trackMs > 22;
    return {
      state: s,
      quality: effQuality,
      pixelCap: s === 'critical' ? 1 : s === 'struggling' ? 1.25 : null,
      stride: s === 'critical' ? 3 : s === 'struggling' && trackHeavy ? 2 : 1,
    };
  }
}
