import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMUtils } from '@pixiv/three-vrm';
import { AVATAR_GROUPS } from './face-map.js?v=20261113.1012-a627f0d';
import { buildFaceConstraints, primsFromThree } from './face-constraints.js?v=20261113.1012-a627f0d';
import { FACE_LIMITS } from './face-limits.js?v=20261113.1012-a627f0d';
import { FaceSmoother } from './face-smooth.js?v=20261113.1012-a627f0d';
import { installScreenFx } from './screen-fx.js?v=20261113.1012-a627f0d';

export { OneEuro } from './face-smooth.js?v=20261113.1012-a627f0d';
// materials that belong to the body (hidden in the AR "head only" lens)
const BODY_MATERIALS = ['SuitDark', 'ClothWhite', 'Pants', 'Buttons', 'BowRed', 'Black'];

export class Avatar {
  constructor(scene) {
    this.scene = scene; this.vrm = null; this.smoother = new FaceSmoother();
    this.fx = { shadeL: 0, shadeR: 0, red: 0, green: 0, static: 0, stress: 0 }; this.manualTint = null;
    this.sweatT = 0;
  }

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
    this.faceGroups = AVATAR_GROUPS.filter((g) => this.groups.includes(g) && !g.startsWith('eyeCorrect'));
    // geometric constraints from the model's own morph targets (screen top, rainbow vs eyes, TV top)
    this.constraints = this.hasPuzzlesFace ? buildFaceConstraints(primsFromThree(vrm.scene), FACE_LIMITS) : null;
    // screen effects (shading that follows the brows, red flash, static, stress lines) live in the screen shader
    this.screenFx = installScreenFx(THREE, vrm.scene, FACE_LIMITS);
    this.smoother.reset();
    // dimensions used to place him over a real person (AR Lens): TV shell box + screen centre, at rest
    vrm.scene.updateMatrixWorld(true);
    // the TV shell's own vertices (primitives share one position buffer -> only the indexed ones count);
    // bind pose = rest pose, in model units
    const box = new THREE.Box3(), v = new THREE.Vector3();
    vrm.scene.traverse((o) => {
      if (!o.isMesh || [].concat(o.material)[0].name !== 'TVShell') return;
      const pos = o.geometry.attributes.position, idx = o.geometry.index;
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i += 3) box.expandByPoint(v.fromBufferAttribute(pos, idx ? idx.getX(i) : i));
    });
    this.tvBox = box.isEmpty() ? null : box;                     // model space (bind pose)
    this.screenCenter = new THREE.Vector3(0, (FACE_LIMITS.visibleTop + FACE_LIMITS.visibleBottom) / 2, 0);
    // screen centre in head-bone space (rest pose): lets the AR lens keep the TV glued to the face
    const headBone = vrm.humanoid.getBoneNode('head');
    if (headBone) {
      const sc = new THREE.Vector3(0, this.screenCenter.y, this.tvBox ? this.tvBox.max.z * 0.9 : 0).applyMatrix4(vrm.scene.matrixWorld);
      this.screenLocal = sc.applyMatrix4(new THREE.Matrix4().copy(headBone.matrixWorld).invert());
    }
    this.bodyMats = [];
    vrm.scene.traverse((o) => { if (o.isMesh) [].concat(o.material).forEach((m) => { if (BODY_MATERIALS.includes(m.name)) this.bodyMats.push(m); }); });
    this.makeSweat();
    return vrm;
  }

  /** AR head-only lens: hide the body (the real person's body stays visible) */
  setBodyVisible(v) { for (const m of this.bodyMats) m.visible = v; }

  /** a cartoon sweat drop beside the TV, parented to the head so it follows every movement */
  makeSweat() {
    const c = document.createElement('canvas'); c.width = 64; c.height = 96; const g = c.getContext('2d');
    g.fillStyle = '#9fe3ff'; g.strokeStyle = '#000'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(32, 6); g.bezierCurveTo(46, 36, 58, 52, 58, 66); g.arc(32, 66, 26, 0, Math.PI); g.bezierCurveTo(6, 52, 18, 36, 32, 6); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.ellipse(24, 62, 6, 10, -0.3, 0, Math.PI * 2); g.fill();
    const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false });
    this.sweat = new THREE.Sprite(mat); this.sweat.scale.set(0.045, 0.0675, 1); this.sweat.visible = false; this.sweat.renderOrder = 10;
    const head = this.vrm.humanoid.getBoneNode('head');
    if (head && this.tvBox) {
      head.add(this.sweat);
      head.updateWorldMatrix(true, false);
      const inv = new THREE.Matrix4().copy(head.matrixWorld).invert();
      // just outside the TV's upper corner (model space -> head-local)
      const p = new THREE.Vector3(this.tvBox.min.x - 0.01, this.tvBox.max.y - 0.06, this.tvBox.max.z).applyMatrix4(this.vrm.scene.matrixWorld).applyMatrix4(inv);
      this.sweatBase = p; this.sweat.position.copy(p);
    }
  }

  /** weights: {group: 0..1}; null = face lost -> relax + idle blinking.
   *  opts: {responsiveness, conf, pop, fx:{static, stress, sweat}} */
  setFace(weights, dt, mood, opts = {}) {
    if (!this.vrm) return;
    const out = this.smoother.step(this.faceGroups, weights, dt, opts);
    this.applyFace(out, dt, mood && weights ? mood : {}, opts.fx || {});
  }

  /** already-smoothed weights (replay / photo / pose presets): solve constraints and show */
  applyFace(out, dt, mood, extra = {}) {
    const vrm = this.vrm; if (!vrm) return;
    out = { ...out };
    // constraints act on the FINAL weights, so what is shown always satisfies them
    if (this.constraints) this.lastConstraint = this.constraints.solve(out);
    for (const g in out) if (this.groups.includes(g)) vrm.blendShapeProxy.setValue(g, out[g]);
    this.applied = out;
    // screen effects: shading eases in/out, the red flash envelope is already shaped by the driver
    const goal = this.manualTint ? { ...mood, red: this.manualTint.red, green: this.manualTint.green } : mood;
    const k = Math.min(1, dt * 4);
    for (const key of ['shadeL', 'shadeR', 'green']) this.fx[key] += ((goal[key] || 0) - this.fx[key]) * k;
    this.fx.red = this.manualTint ? this.fx.red + ((goal.red || 0) - this.fx.red) * k : (goal.red || 0);
    this.fx.static += ((extra.static || 0) - this.fx.static) * Math.min(1, dt * 6);
    this.fx.stress += ((extra.stress || 0) - this.fx.stress) * Math.min(1, dt * 5);
    if (this.screenFx) this.screenFx.set(this.fx, this.constraints ? this.constraints.browLine(out) : null);
    // sweat drop: appears when nervous, slides down, repeats
    if (this.sweat && this.sweatBase) {
      const want = (extra.sweat || 0) > 0.45;
      if (want || this.sweatT > 0) {
        this.sweatT += dt; if (this.sweatT > 1.6) this.sweatT = want ? 0.001 : 0;
        const t = this.sweatT / 1.6;
        this.sweat.visible = this.sweatT > 0;
        this.sweat.position.set(this.sweatBase.x, this.sweatBase.y - t * 0.05, this.sweatBase.z);
        this.sweat.material.opacity = Math.min(1, (1 - t) * 3, t * 8);
      } else this.sweat.visible = false;
    }
  }

  update(dt) { if (this.vrm) this.vrm.update(dt); }
}
