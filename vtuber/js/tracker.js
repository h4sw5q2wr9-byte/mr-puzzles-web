// MediaPipe Tasks (Google's maintained successor of the Holistic solution Kalidoface uses):
// FaceLandmarker (478 landmarks + 52 blendshapes + head pose matrix), PoseLandmarker, HandLandmarker,
// and an optional ImageSegmenter (person mask for the AR Lens). Each module is loaded only when a mode
// needs it, and timed so the app can adapt (Face + Hands -> Face only when the device is too slow).
import { FilesetResolver, FaceLandmarker, PoseLandmarker, HandLandmarker, ImageSegmenter, DrawingUtils } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODELS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  poseLite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  poseFull: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  segment: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
};
export { FaceLandmarker, PoseLandmarker, HandLandmarker, DrawingUtils };

export class Tracker {
  constructor() {
    this.face = this.pose = this.hand = this.seg = null; this.lastTs = 0; this.frame = 0; this.poseKind = null;
    this.ms = { face: 0, pose: 0, hands: 0, seg: 0 };      // smoothed per-module cost (ms)
  }

  async init({ needPose, needHands, needSeg = false, poseModel = 'lite', delegate = 'GPU', onStatus = () => {} }) {
    this.vision ||= await FilesetResolver.forVisionTasks(WASM);
    const make = async (Cls, opts, label) => {
      onStatus(`Loading ${label}…`);
      try { return await Cls.createFromOptions(this.vision, { ...opts, baseOptions: { ...opts.baseOptions, delegate } }); }
      catch (e) {
        if (delegate !== 'CPU') { console.warn(label, 'GPU failed, using CPU', e); return Cls.createFromOptions(this.vision, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }); }
        throw e;
      }
    };
    if (!this.face) this.face = await make(FaceLandmarker, {
      baseOptions: { modelAssetPath: MODELS.face }, runningMode: 'VIDEO', numFaces: 1,
      outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true, minFaceDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
    }, 'face model');
    if (needPose && (!this.pose || this.poseKind !== poseModel)) {
      this.pose?.close?.();
      this.pose = await make(PoseLandmarker, {
        baseOptions: { modelAssetPath: poseModel === 'full' ? MODELS.poseFull : MODELS.poseLite }, runningMode: 'VIDEO', numPoses: 1,
        minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
      }, 'body model');
      this.poseKind = poseModel;
    }
    if (needHands && !this.hand) this.hand = await make(HandLandmarker, {
      baseOptions: { modelAssetPath: MODELS.hand }, runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    }, 'hand model');
    if (needSeg && !this.seg) {
      try {
        this.seg = await make(ImageSegmenter, { baseOptions: { modelAssetPath: MODELS.segment }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false }, 'person mask');
      } catch (e) { console.warn('segmenter unavailable', e); this.segFailed = true; }
    }
    onStatus('');
  }

  /** run the enabled detectors on one frame; ts must increase. opts: {pose, hands, seg, poseEvery} */
  detect(src, tsMs, { pose = false, hands = false, seg = false, poseEvery = 1 } = {}) {
    const ts = Math.max(tsMs, this.lastTs + 1); this.lastTs = ts; this.frame++;
    const out = { face: null, pose: null, hands: null, seg: null, ts };
    const timed = (k, fn) => { const t = performance.now(); const r = fn(); this.ms[k] += (performance.now() - t - this.ms[k]) * 0.1; return r; };
    if (this.face) out.face = timed('face', () => this.face.detectForVideo(src, ts));
    if (pose && this.pose) {
      if (this.frame % poseEvery === 0 || !this.lastPose) this.lastPose = timed('pose', () => this.pose.detectForVideo(src, ts));
      out.pose = this.lastPose;
    }
    if (hands && this.hand) out.hands = timed('hands', () => this.hand.detectForVideo(src, ts));
    if (seg && this.seg) {
      // confidence mask copied out (the task's buffer is reused on the next call)
      out.seg = timed('seg', () => {
        let m = null;
        this.seg.segmentForVideo(src, ts, (r) => {
          const mk = r.confidenceMasks && r.confidenceMasks[r.confidenceMasks.length - 1];
          if (mk) m = { w: mk.width, h: mk.height, data: mk.getAsFloat32Array().slice() };
        });
        return m;
      });
    }
    return out;
  }
}
