import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMUtils } from '@pixiv/three-vrm';
import { AVATAR_GROUPS } from './face-map.js';
import { buildFaceConstraints, primsFromThree } from './face-constraints.js';
import { FACE_LIMITS } from './face-limits.js';
import { FaceSmoother } from './face-smooth.js';
import { installScreenFx } from './screen-fx.js';

export { OneEuro } from './face-smooth.js';

export class Avatar {
  constructor(scene) { this.scene = scene; this.vrm = null; this.smoother = new FaceSmoother(); this.fx = { shadeL: 0, shadeR: 0, red: 0, green: 0 }; this.manualTint = null; }

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
    // screen effects (shading that follows the brows, red flash, optional green) live in the screen shader
    this.screenFx = installScreenFx(THREE, vrm.scene, FACE_LIMITS);
    this.smoother.reset();
    return vrm;
  }

  /** weights: {group: 0..1}; null = face lost -> relax + idle blinking.
   *  opts: {responsiveness, conf, pop} (see face-smooth.js) */
  setFace(weights, dt, mood, opts = {}) {
    const vrm = this.vrm; if (!vrm) return;
    const groups = AVATAR_GROUPS.filter((g) => this.groups.includes(g) && !g.startsWith('eyeCorrect'));
    const out = this.smoother.step(groups, weights, dt, opts);
    // constraints act on the FINAL (smoothed) weights, so what is shown always satisfies them
    if (this.constraints) this.lastConstraint = this.constraints.solve(out);
    for (const g in out) vrm.blendShapeProxy.setValue(g, out[g]);
    this.applied = out;
    // screen effects: shading eases in/out, the red flash envelope is already shaped by the driver
    const goal = this.manualTint ? { ...this.fx, red: this.manualTint.red, green: this.manualTint.green } : (mood && weights ? mood : {});
    const k = Math.min(1, dt * 4);
    for (const key of ['shadeL', 'shadeR', 'green']) this.fx[key] += ((goal[key] || 0) - this.fx[key]) * k;
    this.fx.red = this.manualTint ? this.fx.red + ((goal.red || 0) - this.fx.red) * k : (goal.red || 0);
    if (this.screenFx) this.screenFx.set(this.fx, this.constraints ? this.constraints.browLine(out) : null);
  }

  update(dt) { if (this.vrm) this.vrm.update(dt); }
}
