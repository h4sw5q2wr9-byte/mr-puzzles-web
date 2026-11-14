import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMUtils } from '@pixiv/three-vrm';
import { AVATAR_GROUPS } from './face-map.js?v=20261114.1543-6a1fb90';
import { buildFaceConstraints, primsFromThree } from './face-constraints.js?v=20261114.1543-6a1fb90';
import { FACE_LIMITS } from './face-limits.js?v=20261114.1543-6a1fb90';
import { FaceSmoother } from './face-smooth.js?v=20261114.1543-6a1fb90';
import { installScreenFx } from './screen-fx.js?v=20261114.1543-6a1fb90';

export { OneEuro } from './face-smooth.js?v=20261114.1543-6a1fb90';

export class Avatar {
  constructor(scene) { this.scene = scene; this.vrm = null; this.smoother = new FaceSmoother(); this.fx = { shadeL: 0, shadeR: 0, red: 0, green: 0, furrow: 0 }; this.manualTint = null; }

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
    // core Mr. Puzzles groups -> full face; shapes added in later model versions are optional
    this.hasPuzzlesFace = ['eyeBlink_L', 'eyeWide_L', 'browUp_L', 'mouthSmile_L', 'jawOpen', 'eyeCorrect_L', 'eyeCorrect_R'].every((g) => this.groups.includes(g));
    this.missingGroups = AVATAR_GROUPS.filter((g) => !this.groups.includes(g));
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
    for (const key of ['shadeL', 'shadeR', 'green', 'furrow']) this.fx[key] += ((goal[key] || 0) - this.fx[key]) * k;
    this.fx.red = this.manualTint ? this.fx.red + ((goal.red || 0) - this.fx.red) * k : (goal.red || 0);
    if (this.screenFx) this.screenFx.set(this.fx, this.constraints ? this.constraints.browLine(out) : null);
  }

  update(dt) { if (this.vrm) this.vrm.update(dt); }
}
