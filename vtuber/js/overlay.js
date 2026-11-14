// "What the tracker sees": draws MediaPipe's face, body and hand landmarks over the camera picture
// (or on a dark background). Points the tracker is unsure about are drawn faint.
const POSE_LINES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31], [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
  [15, 17], [15, 19], [15, 21], [17, 19], [16, 18], [16, 20], [16, 22], [18, 20],
];
const HAND_LINES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
// face: outline, brows, eyes, irises, lips (MediaPipe face mesh indices)
const FACE_LOOPS = [
  [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33],
  [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466, 263],
  [70, 63, 105, 66, 107], [336, 296, 334, 293, 300],
  [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61],
  [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78],
];
const COL = { face: '#7ef0e6', pose: '#ffd166', left: '#ff6b9a', right: '#8ab4ff', hand: '#ffffff' };

/**
 * @param g     2D context, already sized to the picture
 * @param res   {face, pose, hands} results of one tracker frame
 * @param o     {mirror: draw mirrored like a selfie view, face/pose/hands: which layers}
 */
export function drawTracking(g, res, { mirror = true, face = true, pose = true, hands = true, scale = 1 } = {}) {
  const W = g.canvas.width, H = g.canvas.height;
  const X = (p) => (mirror ? 1 - p.x : p.x) * W, Y = (p) => p.y * H;
  const lw = Math.max(1.5, W / 320) * scale;
  g.lineCap = 'round'; g.lineJoin = 'round';
  const line = (pts, a, b, color, alpha = 1) => {
    if (!pts[a] || !pts[b]) return;
    g.globalAlpha = alpha; g.strokeStyle = color; g.beginPath(); g.moveTo(X(pts[a]), Y(pts[a])); g.lineTo(X(pts[b]), Y(pts[b])); g.stroke();
  };
  const dot = (p, r, color, alpha = 1) => { g.globalAlpha = alpha; g.fillStyle = color; g.beginPath(); g.arc(X(p), Y(p), r, 0, Math.PI * 2); g.fill(); };
  // face
  const fl = face && res.face?.faceLandmarks?.[0];
  if (fl) {
    g.lineWidth = lw * 0.7;
    for (const loop of FACE_LOOPS) for (let i = 1; i < loop.length; i++) line(fl, loop[i - 1], loop[i], COL.face, 0.9);
    for (let i = 468; i < Math.min(478, fl.length); i++) dot(fl[i], lw * 0.8, COL.face, 0.95);   // irises
  }
  // body (person's left = pink, right = blue; faint = the tracker is unsure / guessing)
  const pl = pose && res.pose?.landmarks?.[0];
  if (pl) {
    const vis = (i) => pl[i].visibility ?? 1;
    g.lineWidth = lw * 1.6;
    for (const [a, b] of POSE_LINES) {
      const left = a % 2 === 1 && b % 2 === 1, right = a % 2 === 0 && b % 2 === 0;
      line(pl, a, b, left ? COL.left : right ? COL.right : COL.pose, 0.25 + 0.75 * Math.min(vis(a), vis(b)));
    }
    for (let i = 11; i < 33; i++) dot(pl[i], lw * 2.2, i % 2 ? COL.left : COL.right, 0.25 + 0.75 * vis(i));
  }
  // hands
  const hl = hands && res.hands?.landmarks;
  if (hl) {
    g.lineWidth = lw;
    hl.forEach((h) => {
      for (const [a, b] of HAND_LINES) line(h, a, b, COL.hand, 0.95);
      for (let i = 0; i < 21; i++) dot(h[i], lw * (i % 4 === 0 ? 1.8 : 1.3), [4, 8, 12, 16, 20].includes(i) ? COL.face : COL.hand, 1);
    });
  }
  g.globalAlpha = 1;
}
