// AR Lens: the live camera fills the screen and Mr. Puzzles is placed over the real person.
//  * background: camera frame (selfie-mirrored for the front camera), optionally with the person blurred
//    or hidden using MediaPipe's selfie segmenter (works in Safari; no depth sensor needed)
//  * placement: an orthographic camera in screen pixels; the avatar is positioned and scaled from
//    landmarks (face width for head mode, shoulders / hips for the body modes); rotations come from the
//    same head / arm solvers as Studio mode.
// Landmarks are on the ANALYSIS frame = horizontal flip of the displayed frame -> display x = 1 - x.
import * as THREE from 'three';
import { fitRect } from './overlay.js?v=20261113.1012-a627f0d';

const _v = new THREE.Vector3();

export class ARLens {
  constructor(bgCanvas) {
    this.bg = bgCanvas; this.ctx = bgCanvas.getContext('2d');
    this.small = document.createElement('canvas'); this.small.width = 48; this.small.height = 36;
    this.maskC = document.createElement('canvas'); this.layer = document.createElement('canvas');
    this.cam = new THREE.OrthographicCamera(0, 1, 0, -1, -2000, 2000); this.cam.position.set(0, 0, 1000);
    this.place = null;     // smoothed placement {x, y, s}
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.bg.clientWidth, h = this.bg.clientHeight;
    if (this.bg.width !== Math.round(w * dpr)) { this.bg.width = Math.round(w * dpr); this.bg.height = Math.round(h * dpr); }
    this.W = w; this.H = h; this.dpr = dpr;
    this.cam.left = 0; this.cam.right = w; this.cam.top = 0; this.cam.bottom = -h; this.cam.updateProjectionMatrix();
  }

  /** draw the camera picture (display orientation) + optional person blur / hide */
  drawBackground(src, mirrored, mask, hide) {
    const iw = src.videoWidth || src.naturalWidth || src.width, ih = src.videoHeight || src.naturalHeight || src.height;
    if (!iw) return null;
    const c = this.ctx, W = this.bg.width, H = this.bg.height;
    const r = fitRect(iw, ih, W, H, true); this.rect = { x: r.x / this.dpr, y: r.y / this.dpr, w: r.w / this.dpr, h: r.h / this.dpr };
    const draw = (ctx, img, x, y, w, h) => {
      ctx.save(); if (mirrored) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, w, h); } else ctx.drawImage(img, x, y, w, h); ctx.restore();
    };
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
    draw(c, src, r.x, r.y, r.w, r.h);
    if (hide !== 'none' && mask) {
      // blurred copy of the frame (tiny canvas scaled up = cheap blur that works in every browser)
      const sm = this.small, sc = sm.getContext('2d');
      sm.width = hide === 'erase' ? 24 : 48; sm.height = Math.round(sm.width * ih / iw);
      sc.drawImage(src, 0, 0, sm.width, sm.height);
      // person mask (analysis frame) -> alpha image
      const mc = this.maskC; if (mc.width !== mask.w) { mc.width = mask.w; mc.height = mask.h; this.maskImg = mc.getContext('2d').createImageData(mask.w, mask.h); }
      const d = this.maskImg.data;
      for (let i = 0; i < mask.data.length; i++) { d[i * 4 + 3] = Math.min(255, Math.max(0, (mask.data[i] - 0.25) * 400)); }
      mc.getContext('2d').putImageData(this.maskImg, 0, 0);
      // layer = blurred frame cut out by the mask (the mask is on the analysis frame = flipped display)
      const L = this.layer; L.width = W; L.height = H; const lc = L.getContext('2d');
      lc.imageSmoothingEnabled = true; draw(lc, sm, r.x, r.y, r.w, r.h);
      if (hide === 'erase') { lc.fillStyle = 'rgba(40,30,60,.25)'; lc.fillRect(0, 0, W, H); }
      lc.globalCompositeOperation = 'destination-in';
      lc.save(); lc.translate(r.x + r.w, r.y); lc.scale(-1, 1); lc.drawImage(mc, 0, 0, r.w, r.h); lc.restore();
      lc.globalCompositeOperation = 'source-over';
      c.drawImage(L, 0, 0);
    }
    return this.rect;
  }

  /** display-space pixel position of an analysis-frame landmark */
  px(p) { const r = this.rect; return [r.x + (1 - p.x) * r.w, r.y + p.y * r.h]; }

  /**
   * place the avatar root over the person. mode: head | upper | full. Returns false if not enough
   * landmarks are visible (the caller keeps the last placement / fades).
   */
  placeAvatar(avatar, snap, res, mode, scale, dt) {
    const vrm = avatar.vrm; if (!vrm || !this.rect) return false;
    const face = snap.faceLm, pose = res.pose?.landmarks?.[0];
    let target = null;
    const tv = avatar.tvBox; const tvW = tv ? tv.max.x - tv.min.x : 0.4;
    const restHead = vrm.humanoid.getBoneNode('head');
    vrm.scene.position.set(0, 0, 0); vrm.scene.scale.setScalar(1); vrm.scene.updateMatrixWorld(true);
    if (mode !== 'head' && pose && (pose[11].visibility ?? 1) > 0.5 && (pose[12].visibility ?? 1) > 0.5) {
      // body modes: shoulders (upper) or hips (full) anchor the body; scale from shoulder width
      const ls = this.px(pose[11]), rs = this.px(pose[12]);
      const shoulderPx = Math.hypot(ls[0] - rs[0], ls[1] - rs[1]);
      const ua = vrm.humanoid.getBoneNode('leftUpperArm').getWorldPosition(new THREE.Vector3());
      const ub = vrm.humanoid.getBoneNode('rightUpperArm').getWorldPosition(new THREE.Vector3());
      const sw = ua.distanceTo(ub) / (vrm.scene.scale.x || 1);
      const s = shoulderPx / sw * 1.15 * scale;
      if (mode === 'full' && (pose[23].visibility ?? 1) > 0.5 && (pose[24].visibility ?? 1) > 0.5) {
        const lh = this.px(pose[23]), rh = this.px(pose[24]);
        const hipsRest = avatar.hipsRestModel || (avatar.hipsRestModel = vrm.humanoid.getBoneNode('hips').getWorldPosition(new THREE.Vector3()).clone());
        // full body: scale by torso height (shoulders -> hips); his shoulders are far wider than a person's
        const torsoPx = Math.hypot((ls[0] + rs[0]) / 2 - (lh[0] + rh[0]) / 2, (ls[1] + rs[1]) / 2 - (lh[1] + rh[1]) / 2);
        const torsoM = (ua.y + ub.y) / 2 - hipsRest.y;
        target = { x: (lh[0] + rh[0]) / 2, y: (lh[1] + rh[1]) / 2, s: Math.sqrt(s * torsoPx / Math.max(0.05, torsoM) * scale), anchorY: hipsRest.y };   // between the two fits
      } else {
        const chestY = (ua.y + ub.y) / 2 / (vrm.scene.scale.x || 1);
        target = { x: (ls[0] + rs[0]) / 2, y: (ls[1] + rs[1]) / 2, s, anchorY: chestY };
      }
    } else if (face) {
      // head: the TV screen centre goes between the eyes; the TV is ~1.5x as wide as the face
      const l = this.px(face[234]), r = this.px(face[454]), m = this.px(face[168]);
      const faceW = Math.hypot(l[0] - r[0], l[1] - r[1]);
      const s = faceW * 1.42 * scale / tvW;
      target = { x: m[0], y: m[1] + faceW * 0.08, s, anchorY: avatar.screenCenter.y, head: true };
    }
    if (!target) return false;
    // smooth placement (jitter-free, but follows fast moves)
    const k = this.place ? Math.min(1, dt * 14) : 1;
    this.place = this.place ? { x: this.place.x + (target.x - this.place.x) * k, y: this.place.y + (target.y - this.place.y) * k, s: this.place.s + (target.s - this.place.s) * k, anchorY: target.anchorY } : target;
    const P = this.place;
    // world (orthographic, y up) = position + scale * R(pi) * model ; put the anchor on the target pixel
    vrm.scene.scale.setScalar(P.s);
    if (target.head && avatar.screenLocal) {
      // keep the TV screen glued to the face while the head bone rotates around the neck
      vrm.scene.position.set(0, 0, 0); vrm.scene.updateMatrixWorld(true);
      const p = _v.copy(avatar.screenLocal).applyMatrix4(restHead.matrixWorld);
      vrm.scene.position.set(P.x - p.x, -P.y - p.y, 0);
    } else {
      vrm.scene.position.set(P.x, -P.y - P.s * P.anchorY, 0);
    }
    return true;
  }
}
