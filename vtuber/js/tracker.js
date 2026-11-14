// Tracking manager: MediaPipe Tasks (Google's maintained successor of the Holistic solution
// Kalidoface uses): FaceLandmarker (478 landmarks + 52 blendshapes), PoseLandmarker (33 pts + world),
// HandLandmarker.
//
//  * one place that loads each model once: bytes kept in Cache Storage (Google serves them
//    uncompressed with a 1-hour cache), downloads in parallel, tasks created one at a time (creating
//    several at once can stall mobile Safari)
//  * real status per tracker for the UI: idle / downloading (bytes) / downloaded / starting / ready /
//    failed (+ error, + how long it took)
//  * a failing optional tracker (hands, body) never takes the others down; failed ones can be retried
//  * unused optional trackers can be released (memory) and are recreated from the cached bytes
import { FilesetResolver, FaceLandmarker, PoseLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODELS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  poseLite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  poseFull: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};
export const MODEL_CACHE = 'mp-models-v1';
const SIZES = { face: 3.8e6, poseLite: 5.8e6, poseFull: 9.4e6, hand: 7.8e6 };   // until headers arrive

/** model bytes from Cache Storage, or downloaded (with progress) and stored there; one download per model */
const pending = {};
async function modelBytes(key, onBytes = () => {}) {
  const url = MODELS[key];
  if (pending[url]) { pending[url].listeners.push(onBytes); return pending[url].p; }
  const entry = { listeners: [onBytes] };
  const emit = (g, t) => entry.listeners.forEach((f) => f(g, t));
  entry.p = (async () => {
    let cache = null;
    try { cache = await caches.open(MODEL_CACHE); const hit = await cache.match(url); if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); emit(b.length, b.length, true); return { buf: b, cached: true }; } } catch {}
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const total = +r.headers.get('content-length') || SIZES[key];
    let buf;
    if (r.body && r.body.getReader) {
      const reader = r.body.getReader(), parts = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; emit(got, total); }
      buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    } else buf = new Uint8Array(await r.arrayBuffer());
    try { await cache?.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); } catch {}
    return { buf, cached: false };
  })();
  pending[url] = entry;
  entry.p.catch(() => { delete pending[url]; });
  return entry.p;
}

const KINDS = ['face', 'pose', 'hand'];
const LABEL = { face: 'face tracking', pose: 'body tracking', hand: 'hand tracking' };

export class Tracker {
  constructor() {
    this.face = this.pose = this.hand = null; this.lastTs = 0; this.frame = 0; this.poseKind = null;
    this.queue = Promise.resolve();
    this.status = Object.fromEntries(KINDS.map((k) => [k, { state: 'idle', got: 0, total: 0, ms: null, error: null, lastUsed: 0 }]));
    this.listeners = new Set();
    this.inferMs = { face: 0, pose: 0, hand: 0 };
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _set(kind, patch) { Object.assign(this.status[kind], patch); this.listeners.forEach((f) => f(kind, this.status[kind])); }
  modelKey(kind, poseModel) { return kind === 'pose' ? (poseModel === 'full' ? 'poseFull' : 'poseLite') : kind; }

  /** download model files in the background (no memory cost beyond the cache, nothing is started) */
  prefetch({ needPose, needHands, poseModel = 'lite' } = {}) {
    // the face model (essential) gets the bandwidth first; body / hands follow
    const one = (k) => {
      if (this[k] || ['downloading', 'starting', 'downloaded'].includes(this.status[k].state)) return Promise.resolve();
      this._set(k, { state: 'downloading', error: null });
      return modelBytes(this.modelKey(k, poseModel), (g, t) => this._set(k, { got: g, total: t }))
        .then(() => { if (this.status[k].state === 'downloading') this._set(k, { state: 'downloaded' }); })
        .catch((e) => this._set(k, { state: 'failed', error: 'download: ' + e.message }));
    };
    one('face').then(() => { if (needPose) one('pose'); if (needHands) one('hand'); });
    fetch(WASM + '/vision_wasm_internal.wasm').catch(() => {});
    fetch(WASM + '/vision_wasm_internal.js').catch(() => {});
  }

  /**
   * make sure the trackers needed now exist. Never throws for optional trackers: their status says
   * 'failed' and the rest keeps working. Returns {ok, failed:[kinds]}. Calls are queued (no overlap).
   */
  init(opts) {
    const run = this.queue.then(() => this._init(opts));
    this.queue = run.catch(() => {});
    return run;
  }

  async _init({ needPose, needHands, poseModel = 'lite', delegate = 'GPU', onStatus = () => {}, retryFailed = false }) {
    const want = [];
    if (!this.face) want.push('face');
    if (needPose && (!this.pose || this.poseKind !== poseModel)) want.push('pose');
    if (needHands && !this.hand) want.push('hand');
    const todo = want.filter((k) => retryFailed || this.status[k].state !== 'failed' || k === 'face');
    if (!todo.length) return { ok: true, failed: want.filter((k) => this.status[k].state === 'failed') };
    const report = () => {
      const st = todo.map((k) => this.status[k]).filter((s) => s.state === 'downloading');
      const got = st.reduce((a, s) => a + s.got, 0), tot = st.reduce((a, s) => a + (s.total || 0), 0);
      if (tot && got < tot) onStatus(`Loading tracking ${Math.round(got / tot * 100)} %`);
    };
    // the wasm runtime + every needed model download in parallel
    const t0 = performance.now();
    const vision = this.vision || FilesetResolver.forVisionTasks(WASM);
    const bytes = {};
    const dl = (k) => {
      this._set(k, { state: 'downloading', error: null });
      return modelBytes(this.modelKey(k, poseModel), (g, t) => { this._set(k, { got: g, total: t }); report(); })
        .catch((e) => { this._set(k, { state: 'failed', error: 'download: ' + e.message }); return null; });
    };
    // face first (essential), then the optional ones
    const faceFirst = todo.includes('face') ? (bytes.face = dl('face')) : Promise.resolve();
    for (const k of todo) if (k !== 'face') bytes[k] = faceFirst.then(() => dl(k));
    try { this.vision = await vision; }
    catch (e) { for (const k of todo) this._set(k, { state: 'failed', error: 'runtime: ' + e.message }); onStatus(''); return { ok: false, failed: todo }; }
    const failed = [];
    // create one at a time, face first (essential)
    for (const k of todo) {
      const got = await bytes[k];
      if (!got) { failed.push(k); continue; }
      this._set(k, { state: 'starting' });
      onStatus(`Starting ${LABEL[k]}…`);
      const ts = performance.now();
      try {
        const task = await this._create(k, got.buf, delegate);
        if (k === 'pose') { this.pose?.close?.(); this.poseKind = poseModel; }
        this[k] = task;
        this._set(k, { state: 'ready', ms: Math.round(performance.now() - ts), total: got.buf.length, got: got.buf.length, lastUsed: performance.now(), fromCache: got.cached });
      } catch (e) {
        console.warn(LABEL[k], 'failed', e);
        this._set(k, { state: 'failed', error: (e && e.message) || String(e) });
        failed.push(k);
      }
    }
    onStatus('');
    this.initMs = Math.round(performance.now() - t0);
    return { ok: !failed.includes('face'), failed };
  }

  async _create(kind, buf, delegate) {
    const Cls = kind === 'face' ? FaceLandmarker : kind === 'pose' ? PoseLandmarker : HandLandmarker;
    const opts = kind === 'face'
      ? { runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true, minFaceDetectionConfidence: 0.5, minTrackingConfidence: 0.5 }
      : kind === 'pose'
        ? { runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5 }
        : { runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.5 };
    try { return await Cls.createFromOptions(this.vision, { ...opts, baseOptions: { modelAssetBuffer: buf, delegate } }); }
    catch (e) {
      if (delegate === 'CPU') throw e;
      console.warn(LABEL[kind], 'GPU failed, using CPU', e);
      return Cls.createFromOptions(this.vision, { ...opts, baseOptions: { modelAssetBuffer: buf, delegate: 'CPU' } });
    }
  }

  /** free an optional tracker's memory (its model stays cached; recreating takes well under a second) */
  release(kind) {
    if (kind === 'face' || !this[kind]) return;
    try { this[kind].close(); } catch {}
    this[kind] = null; if (kind === 'pose') this.poseKind = null;
    this._set(kind, { state: 'downloaded', ms: null });
  }
  /** release optional trackers not used for `idleMs` (e.g. body + hands after a while in Face mode) */
  releaseIdle(idleMs) {
    const now = performance.now();
    for (const k of ['pose', 'hand']) if (this[k] && now - this.status[k].lastUsed > idleMs) this.release(k);
  }

  /** run the enabled detectors on one frame; ts must increase. Inference time per detector is kept. */
  detect(src, tsMs, { pose = false, hands = false } = {}) {
    const ts = Math.max(tsMs, this.lastTs + 1); this.lastTs = ts; this.frame++;
    const out = { face: null, pose: null, hands: null };
    const now = performance.now();
    const run = (k, fn) => { const t = performance.now(); const r = fn(); this.inferMs[k] += (performance.now() - t - this.inferMs[k]) * 0.1; this.status[k].lastUsed = now; return r; };
    if (this.face) out.face = run('face', () => this.face.detectForVideo(src, ts));
    if (pose && this.pose) out.pose = run('pose', () => this.pose.detectForVideo(src, ts));
    if (hands && this.hand) out.hands = run('hand', () => this.hand.detectForVideo(src, ts));
    return out;
  }
}
