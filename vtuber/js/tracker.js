// MediaPipe Tasks (Google's maintained successor of the Holistic solution Kalidoface uses):
// FaceLandmarker (478 landmarks + 52 blendshapes), PoseLandmarker (33 pts + world), HandLandmarker.
//
// Loading: Google serves the model files uncompressed with a 1-hour cache, so they are kept in the
// browser's Cache Storage (downloaded once, then instant), fetched in parallel with one progress
// readout, and can be prefetched in the background before the camera is started.
import { FilesetResolver, FaceLandmarker, PoseLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODELS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  poseLite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  poseFull: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};
const CACHE = 'mp-models-v1';
const SIZES = { face: 3.8e6, poseLite: 5.8e6, poseFull: 9.4e6, hand: 7.8e6 };   // for progress before headers arrive

/** model bytes from Cache Storage, or downloaded (with progress) and stored there */
const pending = {};
async function modelBytes(key, onBytes = () => {}) {
  const url = MODELS[key];
  if (pending[url]) return pending[url];
  pending[url] = (async () => {
    let cache = null;
    try { cache = await caches.open(CACHE); const hit = await cache.match(url); if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); onBytes(b.length, b.length); return b; } } catch {}
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${key} model: HTTP ${r.status}`);
    const total = +r.headers.get('content-length') || SIZES[key];
    let buf;
    if (r.body && r.body.getReader) {
      const reader = r.body.getReader(), parts = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onBytes(got, total); }
      buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    } else buf = new Uint8Array(await r.arrayBuffer());
    try { await cache?.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); } catch {}
    return buf;
  })();
  pending[url].catch(() => { delete pending[url]; });
  return pending[url];
}

export class Tracker {
  constructor() { this.face = this.pose = this.hand = null; this.lastTs = 0; this.frame = 0; this.poseKind = null; this.initing = null; }

  /** download models (and the wasm runtime) in the background without creating anything */
  prefetch({ needPose, needHands, poseModel = 'lite' } = {}) {
    const keys = ['face'];
    if (needPose) keys.push(poseModel === 'full' ? 'poseFull' : 'poseLite');
    if (needHands) keys.push('hand');
    for (const k of keys) modelBytes(k).catch(() => {});
    fetch(WASM + '/vision_wasm_internal.wasm').catch(() => {});
    fetch(WASM + '/vision_wasm_internal.js').catch(() => {});
  }

  async init(opts) {
    // one init at a time (background warm-up and Start may overlap)
    while (this.initing) { try { await this.initing; } catch {} }
    this.initing = this._init(opts);
    try { return await this.initing; } finally { this.initing = null; }
  }

  async _init({ needPose, needHands, poseModel = 'lite', delegate = 'GPU', onStatus = () => {} }) {
    const want = [];
    if (!this.face) want.push(['face', 'face']);
    const poseKey = poseModel === 'full' ? 'poseFull' : 'poseLite';
    if (needPose && (!this.pose || this.poseKind !== poseModel)) want.push(['pose', poseKey]);
    if (needHands && !this.hand) want.push(['hand', 'hand']);
    if (!want.length) return;
    // download everything needed in parallel, one combined progress readout
    const prog = {};
    const report = () => {
      const got = Object.values(prog).reduce((a, p) => a + p[0], 0), tot = Object.values(prog).reduce((a, p) => a + p[1], 0);
      if (tot && got < tot) onStatus(`Loading tracking ${Math.round(got / tot * 100)} %`);
    };
    const [vision, ...bufs] = await Promise.all([
      this.vision || FilesetResolver.forVisionTasks(WASM),
      ...want.map(([, key]) => modelBytes(key, (g, t) => { prog[key] = [g, t]; report(); })),
    ]);
    this.vision = vision;
    const make = async (Cls, opts, label) => {
      onStatus(`Starting ${label}…`);
      try { return await Cls.createFromOptions(this.vision, { ...opts, baseOptions: { ...opts.baseOptions, delegate } }); }
      catch (e) {
        if (delegate !== 'CPU') { console.warn(label, 'GPU failed, using CPU', e); return Cls.createFromOptions(this.vision, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }); }
        throw e;
      }
    };
    for (let i = 0; i < want.length; i++) {
      const [kind] = want[i], buf = bufs[i];
      if (kind === 'face') this.face = await make(FaceLandmarker, {
        baseOptions: { modelAssetBuffer: buf }, runningMode: 'VIDEO', numFaces: 1,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true, minFaceDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
      }, 'face tracking');
      else if (kind === 'pose') {
        this.pose?.close?.();
        this.pose = await make(PoseLandmarker, {
          baseOptions: { modelAssetBuffer: buf }, runningMode: 'VIDEO', numPoses: 1,
          minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
        }, 'body tracking');
        this.poseKind = poseModel;
      } else if (kind === 'hand') this.hand = await make(HandLandmarker, {
        baseOptions: { modelAssetBuffer: buf }, runningMode: 'VIDEO', numHands: 2,
        minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
      }, 'hand tracking');
    }
    onStatus('');
  }

  /** run the enabled detectors on one frame; ts must increase */
  detect(src, tsMs, { pose = false, hands = false } = {}) {
    const ts = Math.max(tsMs, this.lastTs + 1); this.lastTs = ts; this.frame++;
    const out = { face: null, pose: null, hands: null };
    if (this.face) out.face = this.face.detectForVideo(src, ts);
    if (pose && this.pose) out.pose = this.pose.detectForVideo(src, ts);
    if (hands && this.hand) out.hands = this.hand.detectForVideo(src, ts);
    return out;
  }
}
