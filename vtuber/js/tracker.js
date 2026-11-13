// MediaPipe Tasks (Google's maintained successor of the Holistic solution Kalidoface uses):
// FaceLandmarker (478 landmarks + 52 blendshapes), PoseLandmarker (33 pts + world), HandLandmarker.
import { FilesetResolver, FaceLandmarker, PoseLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODELS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  poseLite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  poseFull: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

export class Tracker {
  constructor() { this.face = this.pose = this.hand = null; this.lastTs = 0; this.frame = 0; this.poseKind = null; }

  async init({ needPose, needHands, poseModel = 'lite', delegate = 'GPU', onStatus = () => {} }) {
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
      outputFaceBlendshapes: true, minFaceDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
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
      minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
    }, 'hand model');
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
