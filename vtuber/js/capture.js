// Clean captures: the picture only (avatar, plus the camera background in AR Lens, plus the source video
// side by side in Replay) - never the buttons or the tracking points.
//  * screenshot: PNG (transparent when the background is set to Transparent)
//  * recording: MediaRecorder on a composited canvas (MP4 on Safari, WebM elsewhere), optional microphone
// Also: microphone level for the optional "mouth moves with my voice".

export class Capture {
  constructor() {
    this.c = document.createElement('canvas'); this.g = this.c.getContext('2d'); this.rec = null;
    // a canvas must be in the document for some browsers to emit stream frames; keep it invisible
    Object.assign(this.c.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none', zIndex: '-1' });
    document.body.appendChild(this.c);
  }

  /** layers: [{img (canvas/video/img), rect:{x,y,w,h}, mirror}] in CSS px; size in CSS px */
  compose(layers, w, h, scale = 1, opaqueBg = null) {
    const c = this.c, g = this.g;
    const W = Math.round(w * scale), H = Math.round(h * scale);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
    if (opaqueBg) { g.fillStyle = opaqueBg; g.fillRect(0, 0, W, H); }
    for (const L of layers) {
      if (!L.img) continue;
      const r = L.rect;
      g.save();
      if (L.mirror) { g.translate((r.x + r.w) * scale, r.y * scale); g.scale(-1, 1); g.drawImage(L.img, 0, 0, r.w * scale, r.h * scale); }
      else g.drawImage(L.img, r.x * scale, r.y * scale, r.w * scale, r.h * scale);
      g.restore();
    }
    if (this.track && this.track.requestFrame) this.track.requestFrame();     // one stream frame per composite
    return c;
  }

  async screenshot(canvas, name) {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    await saveFile(new File([blob], name, { type: 'image/png' }));
  }

  get recording() { return !!this.rec; }

  /** start recording the compose canvas; withMic adds the microphone */
  async start(withMic) {
    const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!type || !this.c.captureStream) throw new Error('Recording is not supported in this browser');
    // explicit frames when supported (exactly one per rendered composite), else let the browser sample at 30 fps
    const probe = this.c.captureStream(0), t = probe.getVideoTracks()[0];
    const stream = t && t.requestFrame ? probe : this.c.captureStream(30);
    this.track = stream.getVideoTracks()[0];
    if (withMic) {
      try { this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); this.mic.getAudioTracks().forEach((t) => stream.addTrack(t)); }
      catch (e) { console.warn('mic', e); this.micError = e; }
    }
    this.chunks = []; this.type = type;
    this.rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(500);
  }

  async stop() {
    if (!this.rec) return;
    const done = new Promise((r) => (this.rec.onstop = r));
    this.rec.stop(); await done;
    this.mic?.getTracks().forEach((t) => t.stop()); this.mic = null;
    const blob = new Blob(this.chunks, { type: this.type }); this.rec = null; this.track = null;
    await saveFile(new File([blob], `mr-puzzles-${stamp()}.${this.type.includes('mp4') ? 'mp4' : 'webm'}`, { type: this.type.split(';')[0] }));
  }
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
export { stamp };

/** iPhone / iPad: Share sheet (Save Image / Save Video); elsewhere: download */
export async function saveFile(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** microphone loudness 0..1 (speech-band RMS, fast attack / slower release) */
export class Voice {
  async start() {
    if (this.an) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
    this.an = this.ctx.createAnalyser(); this.an.fftSize = 512; src.connect(bp); bp.connect(this.an);
    this.buf = new Float32Array(this.an.fftSize); this.level = 0;
  }
  stop() { this.stream?.getTracks().forEach((t) => t.stop()); this.ctx?.close(); this.an = null; this.level = 0; }
  read(dt) {
    if (!this.an) return 0;
    this.an.getFloatTimeDomainData(this.buf);
    let s = 0; for (const v of this.buf) s += v * v;
    const rms = Math.sqrt(s / this.buf.length), target = Math.min(1, Math.max(0, (rms - 0.01) * 9));
    this.level += (target - this.level) * Math.min(1, dt * (target > this.level ? 25 : 8));
    return this.level;
  }
}
