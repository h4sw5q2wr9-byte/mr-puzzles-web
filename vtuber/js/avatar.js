import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMUtils } from '@pixiv/three-vrm';
import { AVATAR_GROUPS } from './face-map.js';
import { buildFaceConstraints, primsFromThree } from './face-constraints.js';
import { FACE_LIMITS } from './face-limits.js';

// One-Euro filter: low jitter when still, low lag when moving fast.
export class OneEuro {
  constructor(minCutoff = 1.2, beta = 4, dCutoff = 1.0) { Object.assign(this, { minCutoff, beta, dCutoff }); this.x = null; this.dx = 0; }
  static a(dt, c) { const r = 2 * Math.PI * c * dt; return r / (r + 1); }
  filter(v, dt) {
    if (this.x === null) { this.x = v; return v; }
    const dx = (v - this.x) / dt;
    this.dx += OneEuro.a(dt, this.dCutoff) * (dx - this.dx);
    const c = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.a(dt, c) * (v - this.x);
    return this.x;
  }
}

export class Avatar {
  constructor(scene) { this.scene = scene; this.vrm = null; this.filters = {}; this.current = {}; this.blinkTimer = 2; this.idleBlink = 0; this.tint = { red: 0, green: 0 }; this.manualTint = null; }

  async load(arrayBuffer) {
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(arrayBuffer, '', res, rej));
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    const vrm = await VRM.from(gltf);
    if (this.vrm) { this.scene.remove(this.vrm.scene); VRMUtils.deepDispose(this.vrm.scene); }
    this.vrm = vrm;
    vrm.scene.rotation.y = Math.PI;          // VRM 0.x faces -Z; turn toward the camera (as Kalidoface does)
    vrm.scene.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    this.scene.add(vrm.scene);
    this.groups = Object.keys(vrm.blendShapeProxy._blendShapeGroups);
    this.hasPuzzlesFace = AVATAR_GROUPS.every((g) => this.groups.includes(g));
    // geometric constraints from the model's own morph targets (screen top, rainbow vs eyes, TV top)
    this.constraints = this.hasPuzzlesFace ? buildFaceConstraints(primsFromThree(vrm.scene), FACE_LIMITS) : null;
    // screen material for theatrical colour changes (red = furious, green = sick)
    this.screenMats = [];
    vrm.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { if (m.name === 'Screen' && m.emissionColor) this.screenMats.push(m); }); });
    this.screenBase = this.screenMats[0] ? this.screenMats[0].emissionColor.clone() : null;
    this.filters = {}; this.current = {};
    return vrm;
  }

  /** weights: {group: 0..1}; null = face lost -> relax + idle blinking */
  setFace(weights, dt, mood) {
    const vrm = this.vrm; if (!vrm) return;
    const target = {};
    if (weights) Object.assign(target, weights);
    else {
      for (const g of AVATAR_GROUPS) target[g] = 0;
      // idle life: blink every 2.5-5 s
      this.blinkTimer -= dt;
      if (this.blinkTimer < 0) { this.idleBlink = 0.12; this.blinkTimer = 2.5 + Math.random() * 2.5; }
      if (this.idleBlink > 0) { this.idleBlink -= dt; target.eyeBlink_L = target.eyeBlink_R = 1; }
    }
    const out = {};
    for (const g of AVATAR_GROUPS) {
      if (!this.groups.includes(g) || g.startsWith('eyeCorrect')) continue;
      // blinks must be snappy; the mouth and brows flow (less mechanical); everything else in between
      const f = (this.filters[g] ||= g.startsWith('eyeBlink') ? new OneEuro(4, 30) : g.startsWith('look') ? new OneEuro(1.5, 8)
        : /^(jaw|mouth)/.test(g) ? new OneEuro(1.6, 7) : g.startsWith('brow') ? new OneEuro(1.8, 8) : new OneEuro(2.0, 10));
      const v = weights ? f.filter(target[g] ?? 0, dt) : (this.current[g] ?? 0) + ((target[g] ?? 0) - (this.current[g] ?? 0)) * Math.min(1, dt * (g.startsWith('eyeBlink') ? 30 : 4));
      if (!weights) f.x = v;
      this.current[g] = v;
      out[g] = Math.max(0, Math.min(1, v));
    }
    // constraints act on the FINAL (smoothed) weights, so what is shown always satisfies them
    if (this.constraints) this.lastConstraint = this.constraints.solve(out);
    for (const g in out) vrm.blendShapeProxy.setValue(g, out[g]);
    this.applied = out;
    // screen colour
    const goal = this.manualTint || (mood && weights ? mood : { red: 0, green: 0 });
    const k = Math.min(1, dt * 3);
    this.tint.red += ((goal.red || 0) - this.tint.red) * k;
    this.tint.green += ((goal.green || 0) - this.tint.green) * k;
    if (this.screenBase) {
      // three-vrm 0.x MToon: emissionColor is a Vector4 in sRGB (converted to linear internally)
      const c = this.screenBase.clone()
        .lerp(new THREE.Vector4(0.93, 0.2, 0.18, 1), this.tint.red)
        .lerp(new THREE.Vector4(0.62, 0.86, 0.48, 1), this.tint.green);
      for (const m of this.screenMats) { m.emissionColor.copy(c); m.shouldApplyUniforms = true; }   // 0.x syncs uniforms only when flagged
    }
  }

  update(dt) { if (this.vrm) this.vrm.update(dt); }
}
