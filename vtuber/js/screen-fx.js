// Screen effects drawn by the TV screen's own materials, so they can never leave the display:
//   * purple-grey upper shading whose lower edge follows each brow (the original rig's "Face Gradient"
//     idea, recoloured after the ZAMination frames): tired / disgusted / suspicious / sad looks
//   * optional sickly green gradient (the source rig's own Face Gradient colours)
//   * furrow lines between the brows, brief red flash on sudden anger / shouting
//   * old-TV effects on every screen layer (screen + face): static, tearing, scanlines, a rolling bar
//   * the PuzzleVision "Please Stand By" test card when there is no face to show
// All TV effects work in model space (the bind-pose position of each fragment), so the static noise of
// the screen and of the face layers on top of it lines up into one picture.
// THREE is passed in so the same code runs in the app (ES modules) and the test harness (UMD build).
const FACE_MATS = ['EyeWhite', 'Ink', 'Iris', 'EyeShadow', 'Mouth', 'MouthInterior'];

const COMMON = `varying vec3 vFxPos;
uniform vec4 fxTv;      // static/glitch, scanlines (CRT), stand-by card, time
float fxHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
`;

export function installScreenFx(THREE, root, limits, { cardUrl } = {}) {
  const screens = [], faces = [], faceMeshes = [], borders = [];
  let screenMesh = null;
  root.traverse((o) => {
    if (!o.material) return;
    for (const m of [].concat(o.material)) {
      if (m.name === 'Screen') { if (!screens.includes(m)) screens.push(m); screenMesh = screenMesh || o; }
      else if (FACE_MATS.includes(m.name)) {
        if (!faces.includes(m)) faces.push(m);
        // the face layers (eyes, brows, mouth) are hidden while the stand-by card shows; the screen's own
        // border (a Body primitive that shares the Ink material) stays
        if (o.isMesh && !/^Body/i.test(o.name)) { if (!faceMeshes.includes(o)) faceMeshes.push(o); }
        else if (o.isMesh && !borders.includes(o)) borders.push(o);
      }
    }
  });
  if (!screens.length) return null;
  // the screen's black border shares the Ink material: give it its own (unpatched) copy so the static
  // stays inside the glass and the border keeps framing it
  const own = (m) => { if (!FACE_MATS.includes(m.name)) return m; const c = m.clone(); c.onBeforeCompile = () => {}; c.customProgramCacheKey = () => 'mrp-border'; return c; };
  for (const o of borders) o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);

  // where the test card goes: the visible part of the screen, card aspect kept (cover fit)
  const card = new THREE.Vector4(-0.11, limits.visibleBottom, 0.15, limits.visibleTop);
  let xMin = -0.11, xMax = 0.15;
  if (screenMesh && screenMesh.geometry.index) {
    const P = screenMesh.geometry.attributes.position.array; xMin = 1e9; xMax = -1e9;
    for (const i of screenMesh.geometry.index.array) { const x = P[i * 3]; if (x < xMin) xMin = x; if (x > xMax) xMax = x; }
  }
  const fitCard = (aspect) => {
    const h = limits.visibleTop - limits.visibleBottom, cx = (xMin + xMax) / 2;
    const w = Math.max(h * aspect, xMax - xMin);          // cover: never leave the screen colour showing
    const hh = w / aspect;                                  // (if the screen is wider, crop top/bottom)
    const cy = (limits.visibleTop + limits.visibleBottom) / 2;
    card.set(cx - w / 2, cy - hh / 2, cx + w / 2, cy + hh / 2);
  };
  fitCard(1.5);
  const tex = new THREE.Texture();
  if (cardUrl !== null) {
    const url = cardUrl || new URL('../assets/standby.jpg', import.meta.url).href;
    new THREE.TextureLoader().load(url, (t) => {
      t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
      U.fxCardTex.value = t; fitCard(t.image.width / t.image.height);
    });
  }

  const U = {
    fxAmt: { value: new THREE.Vector4(0, 0, 0, 0) },       // shadeL, shadeR, red, green
    fxBrow: { value: new THREE.Vector4(-0.05, 1.53, 0.05, 1.53) },   // xL, yL, xR, yR (model space)
    fxTop: { value: limits.visibleTop },
    fxFur: { value: 0 },                                    // furrow lines between the brows
    fxBottom: { value: limits.visibleBottom },
    fxTv: { value: new THREE.Vector4(0, 0, 0, 0) },
    fxCard: { value: card },
    fxCardTex: { value: tex },
  };

  const patchVertex = (sh, face) => {
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', COMMON + 'void main() {')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vFxPos = position;
  ${face ? `// glitch: the picture tears sideways in horizontal bands (face layers only: the screen glass stays put)
  if (fxTv.x > 0.01) {
    float band = fxHash(vec2(floor(position.y * 140.0), floor(fxTv.w * 24.0)));
    transformed.x += (band - 0.5) * 0.014 * fxTv.x * step(0.45, band);
  }` : ''}`);
  };
  // CRT + static, shared by every layer so they line up
  const TV_FRAG = `
  {
    // scanlines + a soft bright bar rolling down the picture
    float h = max(0.01, fxTop - fxBottom);
    // (fade them out when the TV is small on screen: thinner than ~2 px they would only make moire)
    float sl = 0.5 + 0.5 * sin(vFxPos.y * 3300.0);
    float slk = 1.0 - smoothstep(0.9, 1.8, fwidth(vFxPos.y * 3300.0 / 6.2832) * 2.0);
    col *= 1.0 - fxTv.y * 0.2 * sl * slk;
    float rb = fract((vFxPos.y - fxBottom) / h * 0.5 + fxTv.w * 0.18);
    col *= 1.0 + fxTv.y * 0.12 * smoothstep(0.0, 0.06, rb) * (1.0 - smoothstep(0.06, 0.2, rb));
    // static: grainy snow, a few bright tear lines, the picture flickers
    if (fxTv.x > 0.001) {
      float fr = floor(fxTv.w * 30.0);
      float n = fxHash(floor(vFxPos.xy * vec2(1100.0, 1400.0)) + fr * vec2(17.0, 31.0));
      vec3 snow = vec3(0.08 + 0.85 * n * n) * (0.85 + 0.15 * sin(vFxPos.y * 3300.0) * slk);
      float tear = step(0.94, fxHash(vec2(floor(vFxPos.y * 180.0), fr)));
      col = mix(col, snow, clamp(fxTv.x * 1.15, 0.0, 1.0)) + vec3(0.25 * tear * fxTv.x);
      col *= 1.0 - 0.15 * fxTv.x * fxHash(vec2(fr, 3.0));
    }
  }`;

  for (const m of screens) {
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      patchVertex(sh, false);
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', `${COMMON}
uniform vec4 fxAmt; uniform vec4 fxBrow; uniform float fxTop; uniform float fxBottom; uniform float fxFur;
uniform vec4 fxCard; uniform sampler2D fxCardTex;
// ink stroke: distance from p to the segment a-b
float fxSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
void main() {`)
        .replace('  // -- Almost done!', `  {
    // which brow governs this column (smooth hand-over between the eyes)
    float bx = smoothstep(0.0, 1.0, clamp((vFxPos.x - fxBrow.x) / (fxBrow.z - fxBrow.x), 0.0, 1.0));
    float by = mix(fxBrow.y, fxBrow.w, bx);
    float amt = mix(fxAmt.x, fxAmt.y, bx);
    // shading starts just under the brow line and deepens towards the top of the screen
    float t = clamp((vFxPos.y - (by - 0.02)) / max(0.01, fxTop - by + 0.03), 0.0, 1.0);
    float sh = amt * smoothstep(0.0, 0.35, t) * (0.45 + 0.55 * t);
    col = mix(col, col * vec3(0.36, 0.31, 0.47), clamp(sh, 0.0, 0.85));
    // sick green gradient (top dark -> bottom light), source rig colours
    float gy = clamp((vFxPos.y - fxBottom) / max(0.01, fxTop - fxBottom), 0.0, 1.0);
    col = mix(col, mix(vec3(0.193, 0.423, 0.067), vec3(0.03, 0.12, 0.02), gy), fxAmt.w);
    // furrow lines between the brows (frown / exhausted, as in the ZAMination frames): three short strokes
    if (fxFur > 0.01) {
      float cx = 0.5 * (fxBrow.x + fxBrow.z), cy = 0.5 * (fxBrow.y + fxBrow.w) - 0.006;
      float gap = abs(fxBrow.z - fxBrow.x);
      float d = 1.0;
      for (int i = -1; i <= 1; i++) {
        float fi = float(i), ox = cx + fi * gap * 0.07;
        d = min(d, fxSeg(vFxPos.xy, vec2(ox + fi * 0.002, cy - 0.006 + abs(fi) * 0.002), vec2(ox - fi * 0.001, cy + 0.005 - abs(fi) * 0.001)));
      }
      col = mix(col, vec3(0.0), (1.0 - smoothstep(0.0006, 0.0011, d)) * fxFur);
    }
    // red flash
    col = mix(col, vec3(0.86, 0.035, 0.025), fxAmt.z);
    // "Please Stand By" test card (the model faces -Z, so +x is the viewer's left)
    if (fxTv.z > 0.001) {
      vec2 uv = vec2((fxCard.z - vFxPos.x) / (fxCard.z - fxCard.x), (vFxPos.y - fxCard.y) / (fxCard.w - fxCard.y));
      uv.x += sin(uv.y * 38.0 + fxTv.w * 2.7) * 0.0012;            // the picture breathes a little
      vec3 c = texture2D(fxCardTex, uv).rgb;
      c = pow(c, vec3(2.2)) * 1.08;                                 // sRGB image -> linear
      vec2 q = uv - 0.5;
      c *= 1.0 - 0.45 * pow(clamp(length(q * vec2(1.0, 1.25)) * 1.25, 0.0, 1.0), 3.0);   // tube vignette
      col = mix(col, c, fxTv.z);
    }
  }${TV_FRAG}
  // -- Almost done!`);
    };
    m.customProgramCacheKey = () => 'mrp-fx-screen-2';
    if (m.extensions) m.extensions.derivatives = true;   // fwidth on WebGL1
    m.needsUpdate = true;
  }
  for (const m of faces) {
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      patchVertex(sh, true);
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', `${COMMON}\nuniform float fxTop; uniform float fxBottom;\nvoid main() {`)
        .replace('  // -- Almost done!', `${TV_FRAG}\n  // -- Almost done!`);
    };
    m.customProgramCacheKey = () => 'mrp-fx-face-2';
    if (m.extensions) m.extensions.derivatives = true;
    m.needsUpdate = true;
  }

  let faceShown = true;
  return {
    /** mood: {shadeL, shadeR, red, green, furrow}; brows: {L:{x,y}, R:{x,y}} from face-constraints browLine() */
    set(mood, brows) {
      U.fxAmt.value.set(mood.shadeL || 0, mood.shadeR || 0, mood.red || 0, mood.green || 0);
      U.fxFur.value = mood.furrow || 0;
      if (brows && brows.L && brows.R) {
        const [a, b] = brows.L.x < brows.R.x ? [brows.L, brows.R] : [brows.R, brows.L];
        const [sa, sb] = brows.L.x < brows.R.x ? [mood.shadeL || 0, mood.shadeR || 0] : [mood.shadeR || 0, mood.shadeL || 0];
        U.fxBrow.value.set(a.x, a.y, b.x, b.y);
        U.fxAmt.value.x = sa; U.fxAmt.value.y = sb;
      }
    },
    /** tv: {glitch 0..1, scan 0..1, standby 0|1, time s}. While the card shows, the face layers are hidden. */
    setTv(tv) {
      U.fxTv.value.set(tv.glitch || 0, tv.scan || 0, tv.standby || 0, (tv.time || 0) % 1000);
      const show = !(tv.standby >= 0.999);
      if (show !== faceShown) { faceShown = show; for (const o of faceMeshes) o.visible = show; }
    },
    cardReady: () => !!U.fxCardTex.value.image,
  };
}
