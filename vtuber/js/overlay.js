// Tracking visualisation: what the trackers actually detect, drawn over the camera picture.
// Landmarks come from the ANALYSIS frame, which is always the horizontal flip of what is displayed
// (see main.js), so display x = 1 - landmark x. Drawn on a separate canvas that is never captured.
import { FaceLandmarker, HandLandmarker, PoseLandmarker } from './tracker.js?v=20261113.1012-a627f0d';

const FACE_MESH = FaceLandmarker.FACE_LANDMARKS_TESSELATION || [];
const FACE_FEATURES = [].concat(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE || [], FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE || [],
  FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW || [], FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW || [], FaceLandmarker.FACE_LANDMARKS_LIPS || [],
  FaceLandmarker.FACE_LANDMARKS_FACE_OVAL || []);
const HAND = HandLandmarker.HAND_CONNECTIONS || [];
const POSE = PoseLandmarker.POSE_CONNECTIONS || [];

/**
 * @param ctx   2D context of the overlay canvas (already sized in device pixels)
 * @param rect  {x, y, w, h} where the camera picture is drawn on that canvas
 * @param res   tracker result {face, pose, hands}
 * @param level 'points' | 'mesh' | 'all'
 * @param info  {conf, handSides:{Left,Right}} for the confidence read-out
 */
export function drawOverlay(ctx, rect, res, level, info = {}) {
  const P = (p) => [rect.x + (1 - p.x) * rect.w, rect.y + p.y * rect.h];
  const lines = (pts, conns, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    for (const c of conns) {
      const a = pts[c.start ?? c[0]], b = pts[c.end ?? c[1]]; if (!a || !b) continue;
      const [x1, y1] = P(a), [x2, y2] = P(b); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  };
  const dots = (pts, color, r, every = 1) => {
    ctx.fillStyle = color;
    for (let i = 0; i < pts.length; i += every) { const [x, y] = P(pts[i]); ctx.fillRect(x - r / 2, y - r / 2, r, r); }
  };
  const s = Math.max(1, rect.w / 400);
  ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();      // never outside the picture
  const face = res.face?.faceLandmarks?.[0];
  if (face) {
    if (level === 'mesh' || level === 'all') lines(face, FACE_MESH, 'rgba(70,201,196,.35)', 0.6 * s);
    lines(face, FACE_FEATURES, 'rgba(232,72,111,.9)', 1.2 * s);
    dots(face, 'rgba(255,255,255,.85)', 1.6 * s, level === 'points' ? 2 : 4);
  }
  for (const h of res.hands?.landmarks || []) { lines(h, HAND, 'rgba(255,214,90,.95)', 2 * s); dots(h, '#fff', 3 * s); }
  const pose = res.pose?.landmarks?.[0];
  if (pose && level === 'all') {
    const vis = pose.map((p) => (p.visibility ?? 1) > 0.5 ? p : null);
    lines(vis, POSE, 'rgba(140,120,255,.9)', 2.5 * s); dots(pose.filter((p) => (p.visibility ?? 1) > 0.5), '#c9b8ff', 4 * s);
  }
  ctx.restore();
  // read-out
  ctx.font = `${Math.round(11 * s)}px -apple-system, sans-serif`; ctx.fillStyle = 'rgba(0,0,0,.55)';
  const txt = [`face ${face ? '✓' : '–'}${info.conf !== undefined ? ' · conf ' + info.conf.toFixed(2) : ''}`,
    `hands ${res.hands ? (res.hands.landmarks || []).length : '–'}`, `body ${pose ? '✓' : '–'}`].join('   ');
  const tw = ctx.measureText(txt).width;
  ctx.fillRect(rect.x + 4, rect.y + rect.h - 20 * s, tw + 10, 16 * s);
  ctx.fillStyle = '#fff'; ctx.fillText(txt, rect.x + 9, rect.y + rect.h - 8 * s);
}

/** where an image of size (iw, ih) is drawn inside a box (bw, bh) with object-fit contain / cover */
export function fitRect(iw, ih, bw, bh, cover = false) {
  const k = cover ? Math.max(bw / iw, bh / ih) : Math.min(bw / iw, bh / ih);
  const w = iw * k, h = ih * k;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}
