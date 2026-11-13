// Direct geometric measurements from the 478 FaceLandmarker landmarks, in a head-aligned frame
// (x along the eye line, y up, unit = inter-ocular distance). These complement the blendshapes,
// which miss one-sided smiles, under-report wide eyes and mix up squinting with brow lowering.
// Pure module (used by the app and by the offline signal tests).
//
// Sides are the SUBJECT's own (MediaPipe convention): 'Left' = subject's left eye/brow/mouth corner.
export const GEOM_IDX = [33, 133, 159, 145, 158, 153, 160, 144, 263, 362, 386, 374, 385, 380, 387, 373,
  70, 105, 107, 300, 334, 336, 61, 291, 13, 14, 0, 17, 1, 152];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** lm: (i) => [x, y] in pixels-like isotropic units (normalized x * aspect, y) */
export function faceGeometry(lm) {
  const cR = mid(lm(33), lm(133)), cL = mid(lm(263), lm(362));
  const iod = dist(cL, cR) || 1e-6;
  const ex = [(cL[0] - cR[0]) / iod, (cL[1] - cR[1]) / iod];       // towards subject's left
  const o = mid(cL, cR);
  // y axis = "up" on the face (image y grows downward)
  const P = (p) => { const d = sub(p, o); return [(d[0] * ex[0] + d[1] * ex[1]) / iod, -(-d[0] * ex[1] + d[1] * ex[0]) / iod]; };
  const eye = (outer, inner, pairs) => {
    const w = dist(lm(outer), lm(inner)) || 1e-6;
    let h = 0; for (const [u, l] of pairs) h += dist(lm(u), lm(l));
    return h / pairs.length / w;
  };
  const eyeY = (a, b) => (P(lm(a))[1] + P(lm(b))[1]) / 2;
  const mc = P(mid(lm(13), lm(14)));
  // corner height relative to the UPPER lip centre (which barely moves when the jaw drops), plus half of
  // the lip gap * 0.3 (fitted on tests/signals: corners sit between the lips and drop ~1/3 as far as the
  // jaw opens). Positive = corner raised. Without this, an open mouth reads as a smile or a frown.
  const up = P(lm(13)), gap = dist(lm(13), lm(14)) / iod;
  const cornerR = P(lm(61)), cornerL = P(lm(291));
  return {
    iod,
    roll: Math.atan2(ex[1], ex[0]),
    eyeOpenRight: eye(33, 133, [[159, 145], [158, 153], [160, 144]]),
    eyeOpenLeft: eye(263, 362, [[386, 374], [385, 380], [387, 373]]),
    // brow height above the eye line (outer / middle / inner)
    browOuterRight: P(lm(70))[1] - eyeY(33, 133), browMidRight: P(lm(105))[1] - eyeY(33, 133), browInnerRight: P(lm(107))[1] - eyeY(33, 133),
    browOuterLeft: P(lm(300))[1] - eyeY(263, 362), browMidLeft: P(lm(334))[1] - eyeY(263, 362), browInnerLeft: P(lm(336))[1] - eyeY(263, 362),
    cornerRight: cornerR[1] - up[1] + 0.3 * gap, cornerLeft: cornerL[1] - up[1] + 0.3 * gap,
    mouthOpen: dist(lm(13), lm(14)) / iod,
    mouthWidth: dist(lm(61), lm(291)) / iod,
    mouthShift: (cornerL[0] + cornerR[0]) / 2 - mc[0],   // + = mouth pulled to subject's left
  };
}

/** helper for FaceLandmarker results: landmarks array of {x,y,z} + video aspect (w/h) */
export function geometryFromLandmarks(landmarks, aspect) {
  return faceGeometry((i) => [landmarks[i].x * aspect, landmarks[i].y]);
}
