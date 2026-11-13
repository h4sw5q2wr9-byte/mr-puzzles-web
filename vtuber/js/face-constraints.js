// Geometry-based face constraints, evaluated on the VRM's ACTUAL morph targets (no hand-tuned tables).
// Pure module: used by the app (three.js geometry) and by tests/face_stress.mjs (parsed .vrm).
//
//   1. Brows / eyes / lashes never rise above the visible top of the TV screen. Offending shapes are
//      scaled down in proportion to how much they push the highest point (soft, continuous).
//   2. The rainbow mouth never rises into an eye: inside each eye's column the mouth's real top is
//      compared with that eye's real bottom edge (which moves with wide / big / squint / blink / ...),
//      and the overflow is cancelled exactly with eyeCorrect_L/R, which lowers the contour only there.
//   3. The rainbow never rises above the TV body.
const MOUTH_RE = /^(jawOpen|mouth)/;
const TOP_RE = /^(brow|eye(?!Correct))/;

export function buildFaceConstraints(prims, limits) {
  // prims: [{ mat, pos: Float32Array(n*3), index: Uint*Array, targets: {name: Float32Array(n*3)} }]
  const byMat = {};
  for (const p of prims) {
    const used = [...new Set(p.index)];
    (byMat[p.mat] ||= []).push({ p, used });
  }
  const pts = (mat, filter) => {
    const out = [];
    for (const { p, used } of byMat[mat] || []) for (const v of used) {
      const x = p.pos[v * 3], y = p.pos[v * 3 + 1];
      if (!filter || filter(x, y)) out.push({ p, v, x, y });
    }
    return out;
  };
  const evalY = (s, w, keys) => {
    let y = s.y;
    for (const k of keys) { const t = s.p.targets[k]; if (t) y += w[k] * t[s.v * 3 + 1]; }
    return y;
  };
  const whites = pts('EyeWhite');
  if (!whites.length || !byMat.Mouth) return null;
  const mx = whites.reduce((a, s) => a + s.x, 0) / whites.length;
  const cy = whites.reduce((a, s) => a + s.y, 0) / whites.length;
  const eyes = [whites.filter((s) => s.x < mx), whites.filter((s) => s.x >= mx)].map((ws) => {
    const x0 = Math.min(...ws.map((s) => s.x)), x1 = Math.max(...ws.map((s) => s.x)), pad = (x1 - x0) * 0.12;
    return { whites: ws, mouth: pts('Mouth', (x) => x > x0 + pad && x < x1 - pad) };
  });
  // which eye is the avatar's L? the one whose column eyeCorrect_L lowers
  const drop = (e, name) => Math.min(...e.mouth.map((s) => (s.p.targets[name] ? s.p.targets[name][s.v * 3 + 1] : 0)));
  const L = drop(eyes[0], 'eyeCorrect_L') < drop(eyes[1], 'eyeCorrect_L') ? 0 : 1;
  eyes[L].side = 'L'; eyes[1 - L].side = 'R';
  for (const e of eyes) e.B = -drop(e, 'eyeCorrect_' + e.side);
  // top samples: everything above the eye centre line (brows, lashes, lids, eye tops), sub-sampled
  let top = [];
  for (const m of ['Ink', 'EyeWhite', 'EyeShadow', 'Iris']) top = top.concat(pts(m, (x, y) => y > cy));
  const stride = Math.max(1, Math.floor(top.length / 900));
  top = top.filter((_, i) => i % stride === 0);
  const mouthAll = pts('Mouth').filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 300)) === 0);

  function solve(w) {
    const keys = Object.keys(w).filter((k) => w[k]);
    const info = { topScaled: 0, eyeCorrect: {}, mouthScaled: 0 };
    // 1) screen top
    const topLimit = limits.visibleTop - limits.topMargin;
    for (let it = 0; it < 4; it++) {
      let worst = null, over = 0;
      for (const s of top) { const o = evalY(s, w, keys) - topLimit; if (o > over) { over = o; worst = s; } }
      if (!worst) break;
      // brows give way first (they have the least headroom); eye shapes only if the brows cannot
      let rest = over, any = false;
      for (const tier of [/^brow/, /^eye(?!Correct)/]) {
        let pos = 0; const contrib = {};
        for (const k of keys) {
          if (!tier.test(k)) continue;
          const t = worst.p.targets[k]; if (!t) continue;
          const c = w[k] * t[worst.v * 3 + 1]; if (c > 0) { contrib[k] = c; pos += c; }
        }
        if (pos <= 1e-9) continue;
        any = true;
        const f = Math.max(0, 1 - rest / pos);
        for (const k in contrib) w[k] *= f;
        info.topScaled = Math.max(info.topScaled, 1 - f);
        rest -= pos * (1 - f);
        if (rest <= 1e-9) break;
      }
      if (!any) break;
    }
    // 3) TV body top (mouth)
    {
      const mk = keys.filter((k) => MOUTH_RE.test(k));
      let mt = -1e9, mt0 = -1e9;
      for (const s of mouthAll) { mt = Math.max(mt, evalY(s, w, mk)); mt0 = Math.max(mt0, s.y); }
      const over = mt - limits.mouthMaxTop;
      if (over > 0 && mt > mt0) { const f = Math.max(0, 1 - over / (mt - mt0)); for (const k of mk) w[k] *= f; info.mouthScaled = 1 - f; }
    }
    // 2) mouth vs eyes (exact corrective per eye; scale the mouth only if one corrective is not enough)
    for (const e of eyes) w['eyeCorrect_' + e.side] = 0;
    const all = Object.keys(w).filter((k) => w[k]);
    for (let it = 0; it < 8; it++) {
      let need = false;
      for (const e of eyes) {
        const bottom = Math.min(...e.whites.map((s) => evalY(s, w, all)));
        const mk = all.filter((k) => MOUTH_RE.test(k) || k === 'eyeCorrect_' + e.side);
        let mtop = -1e9; for (const s of e.mouth) mtop = Math.max(mtop, evalY(s, w, mk));
        const over = mtop - (bottom - limits.eyeMargin);
        if (over > 1e-6) {
          need = true;                       // re-verify next pass: the corrective is not uniform at column edges
          const cur = w['eyeCorrect_' + e.side] || 0;
          const add = over / e.B;
          if (cur + add <= 1) w['eyeCorrect_' + e.side] = cur + add;
          else {
            w['eyeCorrect_' + e.side] = 1;
            // shrink the mouth shapes that rise inside this column
            const rest = over - (1 - cur) * e.B;
            let rise = 0; const rk = [];
            for (const k of all) {
              if (!MOUTH_RE.test(k)) continue;
              let r = 0; for (const s of e.mouth) { const t = s.p.targets[k]; if (t) r = Math.max(r, w[k] * t[s.v * 3 + 1]); }
              if (r > 0) { rise += r; rk.push(k); }
            }
            if (rise > 0) { const f = Math.max(0, 1 - rest / rise); for (const k of rk) w[k] *= f; info.mouthScaled = Math.max(info.mouthScaled, 1 - f); }
            need = true;
          }
          if (!all.includes('eyeCorrect_' + e.side)) all.push('eyeCorrect_' + e.side);
        }
        info.eyeCorrect[e.side] = w['eyeCorrect_' + e.side] || 0;
      }
      if (!need) break;
    }
    return info;
  }
  // brow line per eye (for the screen shading that follows the brows): ink above each eye white
  for (const e of eyes) {
    const x0 = Math.min(...e.whites.map((s) => s.x)), x1 = Math.max(...e.whites.map((s) => s.x)), wd = x1 - x0;
    const yTop = Math.max(...e.whites.map((s) => s.y));
    e.brow = pts('Ink', (x, y) => x > x0 - 0.25 * wd && x < x1 + 0.25 * wd && y > yTop + 0.003);
    e.cx = (x0 + x1) / 2;
  }
  /** current brow heights (model space), evaluated from the actual morph targets */
  function browLine(w) {
    const keys = Object.keys(w).filter((k) => w[k] && /^(brow|eye)/.test(k));
    const out = {};
    for (const e of eyes) {
      let y = 0; for (const s of e.brow) y += evalY(s, w, keys);
      out[e.side] = { x: e.cx, y: e.brow.length ? y / e.brow.length : limits.visibleTop - 0.03 };
    }
    return out;
  }
  return { solve, eyes, browLine, topCount: top.length };
}

/** helper for the browser: collect primitives of the VRM's "Face" mesh from three.js objects */
export function primsFromThree(root) {
  const prims = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.morphTargetDictionary || !o.geometry.index) return;
    const mat = [].concat(o.material)[0].name;
    const g = o.geometry, targets = {};
    const mp = g.morphAttributes.position || [];
    for (const [name, i] of Object.entries(o.morphTargetDictionary)) if (mp[i]) targets[name] = mp[i].array;
    prims.push({ mat, pos: g.attributes.position.array, index: g.index.array, targets });
  });
  return prims;
}
