// Screen effects drawn by the TV screen's own material, so they can never leave the display:
//   * purple-grey upper shading whose lower edge follows each brow (the original rig's "Face Gradient"
//     idea, recoloured after the ZAMination frames): tired / disgusted / suspicious / sad looks
//   * optional sickly green gradient (the source rig's own Face Gradient colours)
//   * brief red flash on sudden anger / shouting
// THREE is passed in so the same code runs in the app (ES modules) and the test harness (UMD build).
export function installScreenFx(THREE, root, limits) {
  const mats = [];
  root.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { if (m.name === 'Screen' && !mats.includes(m)) mats.push(m); }); });
  if (!mats.length) return null;
  const U = {
    fxAmt: { value: new THREE.Vector4(0, 0, 0, 0) },       // shadeL, shadeR, red, green
    fxBrow: { value: new THREE.Vector4(-0.05, 1.53, 0.05, 1.53) },   // xL, yL, xR, yR (model space)
    fxTop: { value: limits.visibleTop },
    fxFur: { value: 0 },                                    // furrow lines between the brows
    fxBottom: { value: limits.visibleBottom },
  };
  for (const m of mats) {
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('void main() {', 'varying vec3 vFxPos;\nvoid main() {')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFxPos = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', `varying vec3 vFxPos;
uniform vec4 fxAmt; uniform vec4 fxBrow; uniform float fxTop; uniform float fxBottom; uniform float fxFur;
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
  }
  // -- Almost done!`);
    };
    m.customProgramCacheKey = () => 'mrp-screenfx';
    m.needsUpdate = true;
  }
  return {
    /** mood: {shadeL, shadeR, red, green}; brows: {L:{x,y}, R:{x,y}} from face-constraints browLine() */
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
  };
}
