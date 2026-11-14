// Microphone: (1) audio for recordings, (2) a voice-driven mouth layer.
// The voice layer is added on top of the tracked face: louder = mouth opens more, the ZAMination
// wavy mouth line wobbles with each syllable, and the mouth sways to one side (the side changes per
// phrase, like a cartoon talking out of the side of its mouth). Low "oo"-ish voices round it a bit.
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Voice {
  constructor() {
    this.on = false; this.level = 0; this.env = 0; this.phase = 0; this.sway = 0; this.side = 1;
    this.round = 0; this.silence = 1; this.floor = -60; this.peak = -30; this.ctx = null; this.stream = null; this.src = null;
  }

  /** must be called from a user gesture (iOS) */
  async start() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 1024; this.analyser.smoothingTimeConstant = 0.2;
      this.dest = this.ctx.createMediaStreamDestination();       // recordings take their audio from here
      this.td = new Float32Array(this.analyser.fftSize); this.fd = new Float32Array(this.analyser.frequencyBinCount);
    }
    const resumed = this.ctx.resume();            // inside the tap (iOS unlocks audio only there)
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    await resumed;
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.src.connect(this.analyser); this.src.connect(this.dest);
    this.on = true;
  }

  stop() {
    this.on = false;
    try { this.src && this.src.disconnect(); } catch {}
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.src = this.stream = null;
  }

  /** audio track for MediaRecorder (silent while the mic is off) */
  track() { return this.dest ? this.dest.stream.getAudioTracks()[0] : null; }

  /** analyse the latest audio; call once per frame */
  update(dt) {
    let db = -100, c = 1500;
    if (this.on && this.analyser) {
      const a = this.analyser;
      a.getFloatTimeDomainData(this.td);
      let s = 0; for (let i = 0; i < this.td.length; i++) s += this.td[i] * this.td[i];
      db = 10 * Math.log10(s / this.td.length + 1e-12);
      // spectral centroid (100 Hz - 4 kHz): dark "oo/oh" sounds round the mouth
      a.getFloatFrequencyData(this.fd);
      const hz = this.ctx.sampleRate / a.fftSize; let num = 0, den = 0;
      for (let i = Math.floor(100 / hz); i < Math.min(this.fd.length, 4000 / hz); i++) { const p = Math.pow(10, this.fd[i] / 20); num += p * i * hz; den += p; }
      if (den > 0) c = num / den;
    }
    return this.feed(db, c, dt);
  }

  /** one analysis step from a loudness (dBFS) and spectral centroid (Hz); used by update() and tests */
  feed(db, c, dt) {
    let target = 0;
    // adaptive range: noise floor (falls quickly, creeps up slowly, so room noise never opens the
    // mouth) and your usual peak loudness (so quiet and loud talkers both get the full range;
    // shouting still opens wider than talking). Digital silence (mic muted / starting) is ignored.
    if (db > -85) {
      this.floor = db < this.floor ? this.floor + (db - this.floor) * Math.min(1, dt / 0.25) : this.floor + dt * 2.5;
      this.floor = Math.max(-80, Math.min(this.floor, -30));
      this.peak = db > this.peak ? db : this.peak - dt * 1.2;
      this.peak = Math.max(this.peak, this.floor + 24);
      target = smoothstep(0.22, 1.0, (db - this.floor) / (this.peak - this.floor)) * smoothstep(-66, -50, db);
    }
    this.round += ((target > 0.15 ? 1 - smoothstep(500, 1100, c) : 0) - this.round) * Math.min(1, dt * 8);
    this.level = target;
    // envelope: fast attack (syllables pop), softer release
    const k = target > this.env ? Math.min(1, dt / 0.035) : Math.min(1, dt / 0.11);
    this.env += (target - this.env) * k;
    // a new phrase after a pause picks a side to talk out of
    if (this.env < 0.05) this.silence += dt;
    else { if (this.silence > 0.45) this.side = Math.random() < 0.5 ? -1 : 1; this.silence = 0; }
    this.phase += dt * (5 + 9 * this.env);
    this.sway += ((this.env > 0.05 ? this.side : 0) - this.sway) * Math.min(1, dt * 3);
    return this.env;
  }

  /** add the voice layer to the (smoothed) face weights; strength 0..1 */
  apply(w, strength = 1) {
    const L = this.env * strength;
    if (L < 0.003) return w;
    const add = (g, v) => { if (g in w) w[g] = clamp01(Math.max(w[g], v)); };
    w.jawOpen = clamp01(w.jawOpen + L * 0.5 * (1 - w.jawOpen) * (0.8 + 0.2 * Math.sin(this.phase * 1.7)));
    add('mouthInterior', smoothstep(0.55, 0.95, L) * 0.4);
    // wavy line that wobbles with the voice
    add('mouthWave', L * (0.55 + 0.4 * Math.sin(this.phase)));
    // sway to one side, rippling
    const sw = Math.abs(this.sway) * L * (0.45 + 0.25 * Math.sin(this.phase * 0.6 + 1.3));
    const side = this.sway >= 0 ? 'L' : 'R', other = side === 'L' ? 'R' : 'L';
    if (('mouthTilt_' + side) in w) { w['mouthTilt_' + side] = clamp01(w['mouthTilt_' + side] + sw); w['mouthTilt_' + other] = clamp01(w['mouthTilt_' + other] - sw); }
    add('mouthRound', this.round * L * 0.45);
    return w;
  }
}
