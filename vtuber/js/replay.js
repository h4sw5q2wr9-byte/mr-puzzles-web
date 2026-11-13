// Replay: photos and videos from the device as the tracking source (processed locally, never uploaded).
//  * video: analysed ONCE frame by frame (seek -> detect -> the same Performer pipeline as the camera),
//    snapshots cached in memory; playback / scrubbing then looks snapshots up by the video's own
//    currentTime, so avatar and footage stay frame-locked and scrubbing back never re-analyses.
//  * photo: one static pose (no invented motion).
import { Performer } from './performer.js?v=20261113.1012-a627f0d';

export class Replay {
  constructor({ tracker, state, avatar, getRig, analysisFrame, onStatus, onProgress }) {
    Object.assign(this, { tracker, state, avatar, getRig, analysisFrame, onStatus, onProgress });
    this.kind = null; this.frames = []; this.fps = 15; this.cache = new Map(); this.busy = false;
  }

  /** load a File (image/* or video/*) into the given <video>/<img> elements and analyse it */
  async load(file, video, img) {
    this.cancel = true; while (this.busy) await new Promise((r) => setTimeout(r, 30)); this.cancel = false;
    const key = `${file.name}|${file.size}|${file.lastModified}|${this.state.track}|${this.state.mirror}|${this.state.tuning.style}`;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    if (file.type.startsWith('image/')) {
      this.kind = 'photo'; video.hidden = true; img.hidden = false; video.removeAttribute('src');
      img.src = this.url; await img.decode();
      this.el = img;
      await this.analysePhoto(img);
      return;
    }
    this.kind = 'video'; img.hidden = true; video.hidden = false;
    video.srcObject = null; video.src = this.url; video.muted = true; video.playsInline = true; video.loop = false;
    await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = () => rej(new Error('This video format is not supported by the browser')); });
    this.el = video; this.duration = video.duration;
    if (this.cache.has(key)) { const c = this.cache.get(key); this.frames = c.frames; this.fps = c.fps; this.onStatus(''); return; }
    await this.analyseVideo(video);
    if (!this.cancel) this.cache.set(key, { frames: this.frames, fps: this.fps });
  }

  async analysePhoto(img) {
    this.onStatus('Analysing photo…');
    await this.tracker.init({ needPose: this.state.track !== 'face', needHands: this.state.track !== 'face', poseModel: this.state.poseModel, delegate: this.state.delegate });
    const perf = new Performer({ avatar: this.avatar, getRig: this.getRig, state: this.state });
    const frame = this.analysisFrame(img);
    const res = this.tracker.detect(frame, performance.now(), { pose: this.state.track !== 'face', hands: this.state.track !== 'face' });
    const snap = perf.track(res, { width: frame.width, height: frame.height }, { track: this.state.track, now: 0, dt: 1 / 30 });
    snap.res = slim(res); delete snap.faceLm;
    this.frames = [snap]; this.fps = 1;
    this.onStatus(snap.face ? '' : 'No face found in this photo');
  }

  async analyseVideo(video) {
    this.busy = true;
    const st = this.state;
    await this.tracker.init({ needPose: st.track !== 'face', needHands: st.track !== 'face', poseModel: st.poseModel, delegate: st.delegate });
    // analysis rate: every frame up to 30 fps for short clips, 15 fps for long ones (playback interpolates)
    this.fps = video.duration <= 6 ? 24 : 15;
    const n = Math.max(1, Math.floor(video.duration * this.fps));
    const perf = new Performer({ avatar: this.avatar, getRig: this.getRig, state: st });
    this.frames = []; video.pause();
    const t0 = performance.now(), base = this.tracker.lastTs + 1000;
    for (let i = 0; i < n && !this.cancel; i++) {
      await seek(video, i / this.fps);
      const frame = this.analysisFrame(video);
      const res = this.tracker.detect(frame, base + i * 1000 / this.fps, { pose: st.track !== 'face', hands: st.track !== 'face' });
      const snap = perf.track(res, { width: frame.width, height: frame.height }, { track: st.track, now: i / this.fps, dt: 1 / this.fps });
      snap.res = slim(res); delete snap.faceLm;
      this.frames.push(snap);
      if (i % 5 === 0) {
        const pct = Math.round(i / n * 100), eta = (performance.now() - t0) / (i + 1) * (n - i) / 1000;
        this.onProgress(i / n); this.onStatus(`Analysing video… ${pct} % (${Math.ceil(eta)} s left)`);
        await new Promise((r) => setTimeout(r, 0));     // keep the page responsive
      }
    }
    this.busy = false; this.onProgress(1);
    this.onStatus(this.cancel ? '' : '');
    await seek(video, 0);
  }

  /** snapshot for a media time (nearest analysed frame; face weights interpolated between frames) */
  at(t) {
    if (!this.frames.length) return null;
    if (this.kind === 'photo') return this.frames[0];
    const x = Math.max(0, Math.min(this.frames.length - 1, t * this.fps));
    const i = Math.floor(x), j = Math.min(this.frames.length - 1, i + 1), f = x - i;
    const a = this.frames[i], b = this.frames[j];
    if (!a.face || !b.face || f < 1e-3) return f < 0.5 ? a : b;
    const w = {};
    for (const k in a.face.weights) w[k] = a.face.weights[k] * (1 - f) + (b.face.weights[k] ?? 0) * f;
    const near = f < 0.5 ? a : b;
    return { ...near, face: { ...near.face, weights: w } };
  }
}

function seek(video, t) {
  return new Promise((res) => {
    if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) return res();
    const done = () => { video.removeEventListener('seeked', done); res(); };
    video.addEventListener('seeked', done); video.currentTime = t + 1e-4;
  });
}
// keep only what the overlay needs (landmarks, packed into typed arrays) - a phone has to hold minutes of it
const pack = (pts, vis = false) => { const a = new Float32Array(pts.length * (vis ? 3 : 2)); pts.forEach((p, i) => { a[i * (vis ? 3 : 2)] = p.x; a[i * (vis ? 3 : 2) + 1] = p.y; if (vis) a[i * 3 + 2] = p.visibility ?? 1; }); return a; };
export const unpack = (a, vis = false) => { const n = vis ? 3 : 2, out = new Array(a.length / n); for (let i = 0; i < out.length; i++) out[i] = { x: a[i * n], y: a[i * n + 1], visibility: vis ? a[i * n + 2] : 1 }; return out; };
function slim(res) {
  return {
    face: res.face?.faceLandmarks?.[0] ? pack(res.face.faceLandmarks[0]) : null,
    hands: res.hands ? (res.hands.landmarks || []).map((h) => pack(h)) : null,
    pose: res.pose?.landmarks?.[0] ? pack(res.pose.landmarks[0], true) : null,
  };
}
/** packed -> tracker-result shape for the overlay */
export function expand(r) {
  if (!r) return {};
  return {
    face: r.face ? { faceLandmarks: [unpack(r.face)] } : null,
    hands: r.hands ? { landmarks: r.hands.map((h) => unpack(h)) } : null,
    pose: r.pose ? { landmarks: [unpack(r.pose, true)] } : null,
  };
}
