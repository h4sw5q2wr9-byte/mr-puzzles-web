// MediaPipe Face Landmarker wrapper: blendshapes + facial transformation matrix, GPU delegate with CPU fallback.
import { FilesetResolver, FaceLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';
import { toLensNames } from './mp_map.js';

export class FaceTracker {
  constructor() { this.landmarker = null; this.delegate = null; this.lsWeights = {}; this.lastTs = 0; }

  async init(onStatus = () => {}) {
    onStatus('Loading face tracker…');
    const fileset = await FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm');
    const make = delegate => FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './models/face_landmarker.task', delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5
    });
    const forced = new URLSearchParams(location.search).get('delegate');      // ?delegate=cpu to test the fallback
    try { if (forced === 'cpu') throw new Error('CPU delegate requested'); this.landmarker = await make('GPU'); this.delegate = 'GPU'; }
    catch (e) {
      console.warn('GPU delegate failed, falling back to CPU', e);
      this.landmarker = await make('CPU'); this.delegate = 'CPU';
    }
    onStatus('');
    return this.delegate;
  }

  /** @returns {{found:boolean, matrix:number[]|null, weights:object|null, ms:number}} */
  detect(video, nowMs) {
    const t0 = performance.now();
    // timestamps must strictly increase
    let ts = Math.round(nowMs); if (ts <= this.lastTs) ts = this.lastTs + 1; this.lastTs = ts;
    const r = this.landmarker.detectForVideo(video, ts);
    const ms = performance.now() - t0;
    if (!r || !r.faceBlendshapes || !r.faceBlendshapes.length || !r.facialTransformationMatrixes || !r.facialTransformationMatrixes.length) {
      return { found: false, matrix: null, weights: null, ms };
    }
    toLensNames(r.faceBlendshapes[0].categories, this.lsWeights);
    return { found: true, matrix: r.facialTransformationMatrixes[0].data, weights: this.lsWeights, ms };
  }

  close() { if (this.landmarker) this.landmarker.close(); this.landmarker = null; }
}
