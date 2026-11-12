// MrPuzzlesRig: loads the optimized Mr. Puzzles GLB (the same model as the Snapchat Lens project) and drives his
// ORIGINAL face rig: the face meshes are skinned to the real face bones; every expression control moves those bones by
// the amounts recorded from the original Blender rig (data/rig.json).  Nothing is redrawn or replaced by sprites.
import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from '../vendor/three/addons/environments/RoomEnvironment.js';

const FACE_PARTS = ['Face_Mouth', 'Face_MouthLine', 'Face_Lids', 'Face_EyeWhite', 'Face_EyeLine', 'Face_Pupils',
  'Face_WrinkleInner_A', 'Face_WrinkleInner_B', 'Face_WrinkleOuter_A', 'Face_WrinkleOuter_B', 'Face_Lashes', 'Face_Brows'];

function rateFor(name) {            // attack/release speed (1/s) per control: blinks + jaw are fast, brows lazier
  if (name.startsWith('eyeBlink')) return 55;
  if (name === 'jawOpen') return 34;
  if (name.startsWith('eyeLook')) return 26;
  if (name.startsWith('brow')) return 20;
  if (name.startsWith('eyeFull')) return 12;
  if (name.startsWith('wrinkle')) return 14;
  if (name.startsWith('mouth')) return 22;
  return 18;
}

export class MrPuzzlesRig {
  /** @param {object} data rig.json  @param {string} url GLB */
  static async load(url, data, renderer, onProgress) {
    const gltf = await new GLTFLoader().loadAsync(url, e => onProgress && e.total && onProgress(e.loaded / e.total));
    const rig = new MrPuzzlesRig(gltf, data);
    rig.envMap = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    rig.prepareMaterials();
    return rig;
  }

  constructor(gltf, data) {
    this.data = data;
    this.pivot = new THREE.Group();            // outer group: the app positions / scales / rotates this one
    this.model = gltf.scene;                   // inner: squash & stretch, shake
    this.pivot.add(this.model);
    this.nodes = {};                           // by ORIGINAL (Blender) name: GLTFLoader strips '.' from node names
    this.model.traverse(o => { this.nodes[o.userData.name || o.name] = o; });
    this.glassMat = null; this.glassColor = new THREE.Color();
    this.tint = [0.93, 0.96, 0.86];

    this.model.updateMatrixWorld(true);
    this.model.traverse(o => { if (o.isSkinnedMesh) o.frustumCulled = false; });

    // ---- bones
    this.bones = {}; this.rest = {}; this.toParent = {};
    const inv = new THREE.Matrix4(), v = new THREE.Vector3();
    for (const name of Object.keys(data.bones)) {
      const b = this.nodes[name];
      if (!b) { (this.missing = this.missing || []).push(name); continue; }
      this.bones[name] = b;
      b.getWorldPosition(v);
      this.rest[name] = this.model.worldToLocal(v.clone());
      // fixed matrix model-space -> bone-parent space (ancestors never move, so this stays valid)
      inv.copy(b.parent.matrixWorld).invert();
      this.toParent[name] = inv.clone().multiply(this.model.matrixWorld);
    }
    this.calibrate();

    // ---- controls -> [bone, dx, dy, dz] lists
    this.shapeBones = {}; this.shapeNames = Object.keys(data.shapes);
    this.value = {}; this.rates = {};
    for (const s of this.shapeNames) {
      this.shapeBones[s] = Object.entries(data.shapes[s]).filter(([b]) => this.bones[b]).map(([b, o]) => [b, o[0], o[1], o[2]]);
      this.value[s] = 0; this.rates[s] = rateFor(s);
    }
    this.active = new Set();
    this.acc = {}; this.tmp = new THREE.Vector3();

    // ---- secondary motion
    this.hat = this.nodes.Hat; this.antL = this.nodes.Antenna_L; this.antR = this.nodes.Antenna_R;
    this.base = {};
    for (const [k, o] of [['hat', this.hat], ['AL', this.antL], ['AR', this.antR]]) if (o) this.base[k] = { q: o.quaternion.clone(), p: o.position.clone() };
    this.spring = { AL: [0, 0, 0, 0], AR: [0, 0, 0, 0] };
    this.hatLift = 0; this.hatLiftV = 0; this.energy = 0; this.anger = 0;
    this.lastPos = new THREE.Vector3(); this.lastVel = new THREE.Vector3(); this.haveLast = false;
    this.pose = { acc: new THREE.Vector3(), q: new THREE.Quaternion() };
    this.stats = { bonesMoved: 0 };
  }

  /** model basis + unit scale from three reference bones (robust against export axis / scale differences) */
  calibrate() {
    this.basis = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }; this.unit = 1;
    const a = this.rest.R_UpperEye, b = this.rest.L_UpperEye, c = this.rest.R_LowerEye;
    if (!(a && b && c)) return;
    const ex = b.clone().sub(a);
    this.unit = ex.length() / Math.abs(this.data.bones.L_UpperEye[0] - this.data.bones.R_UpperEye[0]);
    ex.normalize();
    const ey = a.clone().sub(c); ey.sub(ex.clone().multiplyScalar(ey.dot(ex))).normalize();
    this.basis = { x: ex, y: ey, z: new THREE.Vector3().crossVectors(ex, ey) };
  }

  prepareMaterials() {
    const basic = (m, extra = {}) => new THREE.MeshBasicMaterial(Object.assign({ color: m.color.clone(), map: m.map || null, side: THREE.DoubleSide, toneMapped: false }, extra));
    this.model.traverse(o => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const out = mats.map(m => {
        if (m.name === 'MP_Glass') { const g = basic(m); this.glassMat = g; return g; }
        if (m.name && m.name.startsWith('MP_')) return basic(m);   // face layers: unlit, like the original emission shaders
        // TV, hat, antennas, body: lit PBR
        m.envMap = this.envMap; m.envMapIntensity = 1.1; m.metalness = Math.min(m.metalness, 0.3);
        if (m.name === 'Material.018') {
          // In Blender this material mixes the "puzzlevision" lettering (alpha mask) over the shell colour; glTF only kept the
          // bare texture (tiled over the whole shell).  Use the plain shell colour here and re-add the lettering as a decal.
          m.map = null; m.color.setRGB(0.305, 0.250, 0.328, THREE.LinearSRGBColorSpace);
        }
        m.needsUpdate = true;
        return m;
      });
      o.material = Array.isArray(o.material) ? out : out[0];
    });
    // the original uses 1x1 colour materials that GLTFLoader may have given a map; make sure bars keep theirs
    if (this.nodes.Face_Mouth && this.nodes.Face_Mouth.material.map) this.nodes.Face_Mouth.material.map.colorSpace = THREE.SRGBColorSpace;
  }

  /** "puzzlevision" lettering as a decal on the bezel under the screen (position found by ray-casting the real shell mesh). */
  addLabelDecal(texture) {
    const tv = this.nodes.TV_Body; if (!tv) return;
    texture.colorSpace = THREE.SRGBColorSpace;
    // the PNG is 404x78 with the ink at (3,19)-(395,70): crop to the ink
    texture.repeat.set(392 / 404, 51 / 78); texture.offset.set(3 / 404, 1 - 70 / 78); texture.anisotropy = 4;
    const width = 14.6, height = width * 51 / 392;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const ray = new THREE.Raycaster(); this.model.updateMatrixWorld(true);
    const yLabel = this.data.labelY !== undefined ? this.data.labelY : -8.85;           // cm below the screen centre (middle of the bezel strip under the glass)
    ray.set(new THREE.Vector3(-0.3, yLabel, 80), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObject(tv, true)[0];
    if (!hit) { console.warn('label decal: no hit'); return; }
    const n = hit.face.normal.clone().transformDirection(tv.matrixWorld);
    mesh.position.copy(hit.point).addScaledVector(n, 0.04);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    mesh.renderOrder = 2; mesh.name = 'LabelDecal';
    this.model.add(mesh); this.model.worldToLocal(mesh.position);
    return mesh;
  }

  setBodyVisible(v) { if (this.nodes.Body) this.nodes.Body.visible = v; }

  /**
   * @param {number} dt seconds
   * @param {object} out MoodLogic.compute() result
   * @param {object} ctx { pos: Vector3 (world, cm), quat: Quaternion (world), secondary: bool, time: s }
   */
  update(dt, out, ctx) {
    // 1. smooth every control towards its target (separate attack/release speeds)
    for (const n of this.shapeNames) {
      const k = 1 - Math.exp(-this.rates[n] * dt);
      this.value[n] += ((out.shapes[n] || 0) - this.value[n]) * k;
    }
    // 2. accumulate bone offsets (cm, model space)
    const acc = this.acc;
    for (const k in acc) { acc[k][0] = acc[k][1] = acc[k][2] = 0; }
    const touched = [];
    for (const n of this.shapeNames) {
      const w = this.value[n];
      if (w < 0.002) continue;
      for (const [b, dx, dy, dz] of this.shapeBones[n]) {
        let a = acc[b]; if (!a) a = acc[b] = [0, 0, 0];
        if (a[0] === 0 && a[1] === 0 && a[2] === 0) touched.push(b);
        a[0] += dx * w; a[1] += dy * w; a[2] += dz * w;
      }
    }
    const { x, y, z } = this.basis, u = this.unit, t = this.tmp;
    const now = new Set();
    for (const b of touched) {
      now.add(b);
      const a = acc[b];
      t.copy(this.rest[b])
        .addScaledVector(x, a[0] * u).addScaledVector(y, a[1] * u).addScaledVector(z, a[2] * u)
        .applyMatrix4(this.toParent[b]);
      this.bones[b].position.copy(t);
    }
    for (const b of this.active) {              // bones that stopped moving go back to rest
      if (!now.has(b)) { t.copy(this.rest[b]).applyMatrix4(this.toParent[b]); this.bones[b].position.copy(t); }
    }
    this.active = now; this.stats.bonesMoved = now.size;

    // 3. the rig's own style switches
    const s = out.style, N = this.nodes;
    this.pupilsHold = s.pupils ? 0.22 : Math.max(0, (this.pupilsHold || 0) - dt);   // hold so pupils don't flicker
    if (N.Face_Pupils) N.Face_Pupils.visible = this.pupilsHold > 0;
    if (N.Face_WrinkleInner_A) N.Face_WrinkleInner_A.visible = s.innerWrinkles >= 1;
    if (N.Face_WrinkleInner_B) N.Face_WrinkleInner_B.visible = s.innerWrinkles >= 2;
    if (N.Face_WrinkleOuter_A) N.Face_WrinkleOuter_A.visible = s.outerWrinkles >= 1;
    if (N.Face_WrinkleOuter_B) N.Face_WrinkleOuter_B.visible = s.outerWrinkles >= 2;

    // 4. glass colour (the rig's Base Face Color)
    const tk = 1 - Math.exp(-7 * dt);
    for (let i = 0; i < 3; i++) this.tint[i] += (out.tint[i] - this.tint[i]) * tk;
    if (this.glassMat) this.glassMat.color.setRGB(this.tint[0], this.tint[1], this.tint[2], THREE.SRGBColorSpace);

    this.energy += (out.energy - this.energy) * (1 - Math.exp(-9 * dt));
    this.anger += (out.mood.anger - this.anger) * (1 - Math.exp(-9 * dt));
    if (ctx.secondary) this.secondary(dt, ctx); else this.resetSecondary();
  }

  resetSecondary() {
    this.model.scale.set(1, 1, 1); this.model.position.set(0, 0, 0);
    for (const [k, o] of [['hat', this.hat], ['AL', this.antL], ['AR', this.antR]]) if (o && this.base[k]) { o.quaternion.copy(this.base[k].q); o.position.copy(this.base[k].p); }
  }

  secondary(dt, ctx) {
    // head acceleration expressed in head space drives the antenna springs
    const acc = this.pose.acc;
    if (this.haveLast) {
      const vel = acc.copy(ctx.pos).sub(this.lastPos).multiplyScalar(1 / dt);
      acc.copy(vel).sub(this.lastVel).multiplyScalar(1 / dt);
      this.lastVel.copy(vel);
    } else { acc.set(0, 0, 0); this.haveLast = true; }
    this.lastPos.copy(ctx.pos);
    acc.applyQuaternion(this.pose.q.copy(ctx.quat).invert());
    const ax = THREE.MathUtils.clamp(acc.x * 0.0009, -1.2, 1.2), ay = THREE.MathUtils.clamp(acc.y * 0.0009, -1.2, 1.2);
    const e = this.energy, an = this.anger, tm = ctx.time;
    const step = (key, obj, stiff, damp, gain, sign) => {
      if (!obj) return;
      const st = this.spring[key];
      st[2] += (-stiff * st[0] - damp * st[2] + gain * ay) * dt;
      st[3] += (-stiff * st[1] - damp * st[3] - gain * ax) * dt;
      st[0] = THREE.MathUtils.clamp(st[0] + st[2] * dt, -0.9, 0.9); st[1] = THREE.MathUtils.clamp(st[1] + st[3] * dt, -0.9, 0.9);
      const shiver = an * 0.05 * Math.sin(tm * 61 + (sign > 0 ? 0 : 2));
      this._e = this._e || new THREE.Euler(); this._q = this._q || new THREE.Quaternion();
      this._e.set(st[0] + shiver, 0, st[1] - e * 0.12 * sign);
      obj.quaternion.copy(this.base[key].q).multiply(this._q.setFromEuler(this._e));
    };
    step('AL', this.antL, 70, 5.5, 55, 1);
    step('AR', this.antR, 55, 4.5, 65, -1);
    if (this.hat) {                                  // the hat pops up on big reactions and springs back
      this.hatLiftV += (-160 * (this.hatLift - e * 0.9) - 14 * this.hatLiftV) * dt;
      this.hatLift += this.hatLiftV * dt;
      this.hat.position.set(this.base.hat.p.x, this.base.hat.p.y + this.hatLift, this.base.hat.p.z);
    }
    const stretch = this.value.jawOpen || 0;          // squash & stretch with the jaw, shake when angry
    this.model.scale.set(1 - 0.035 * stretch + 0.02 * e, 1 + 0.05 * stretch, 1);
    const sh = an * an * 0.35;
    this.model.position.set((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, 0);
  }
}
