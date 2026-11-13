// "Studio" render look: physically lit materials + a three-point light rig modelled on the Blender
// renders of the character (warm key light, strong violet rim lights, soft shadows, glossy plastic,
// fuzzy fabric). The 2D face and the TV screen stay unlit (they are a glowing screen) and are not
// tone-mapped, so expressions keep their exact colours. "Toon" restores the original VRM (MToon) look.
// THREE is passed in so the same code runs in the app and the test harness.
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const SCREEN = ['EyeWhite', 'Ink', 'Iris', 'EyeShadow', 'Mouth', 'MouthInterior', 'Screen'];
// per-material surface: roughness, metalness, clearcoat, fabric bump strength
const SURF = {
  TVShell: { r: 0.42, m: 0.0, cc: 0.35 },
  TVMetal: { r: 0.32, m: 0.55, cc: 0.2 },
  HatDark: { r: 0.45, m: 0.0, cc: 0.25 },
  DarkTrim: { r: 0.5, m: 0.0 },
  Black: { r: 0.32, m: 0.0, cc: 0.4 },
  Buttons: { r: 0.3, m: 0.0, cc: 0.4 },
  BowRed: { r: 0.75, m: 0.0, bump: 0.6 },
  SuitDark: { r: 0.72, m: 0.0, bump: 0.5 },
  ClothWhite: { r: 0.9, m: 0.0, bump: 1.0 },
  Pants: { r: 0.8, m: 0.0, bump: 0.4 },
};

/** fine knit / felt noise used as a bump map on fabric (the gloves and sleeves look fuzzy in the renders) */
function fabricTexture(THREE) {
  const n = 256, c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d'), img = g.createImageData(n, n);
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const base = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) base[i] = rnd();
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    // blur the noise a little (felt), plus a faint weave
    let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += base[((y + dy + n) % n) * n + ((x + dx + n) % n)];
    const v = (s / 9) * 0.8 + 0.2 * (0.5 + 0.5 * Math.sin(x * 0.9) * Math.sin(y * 0.9));
    const i = (y * n + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(v * 255); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(10, 10);
  return t;
}

export function installLook(THREE, { renderer, scene, vrm }) {
  // ---- lights (two rigs; only one is visible at a time) --------------------------------------
  const toon = new THREE.Group(), studio = new THREE.Group();
  {
    const key = new THREE.DirectionalLight(0xffffff, 0.75); key.position.set(0.6, 2.2, 3);
    const rim = new THREE.DirectionalLight(0xb48cff, 0.5); rim.position.set(-2, 2, -2);
    toon.add(key, rim, new THREE.HemisphereLight(0xe8e0ff, 0x302040, 0.55));
  }
  {
    // warm key from the front right, high (soft shadows); violet rims from behind both sides;
    // a cool low fill so the shadow side is purple, not black (as in the renders)
    const key = new THREE.DirectionalLight(0xfff0e6, 1.55); key.position.set(2.4, 3.0, 2.2);
    key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
    const sc = key.shadow.camera; sc.left = -1.3; sc.right = 1.3; sc.top = 2.2; sc.bottom = -0.2; sc.near = 0.5; sc.far = 9; key.shadow.radius = 4;
    key.target.position.set(0, 1.0, 0);
    const rimL = new THREE.SpotLight(0xa47cff, 14.0, 0, 0.7, 0.5); rimL.position.set(-3.0, 2.5, -1.2); rimL.target.position.set(0, 1.2, 0);
    const rimR = new THREE.SpotLight(0x9070ff, 8.0, 0, 0.7, 0.5); rimR.position.set(3.0, 2.2, -1.4); rimR.target.position.set(0, 1.2, 0);
    const fill = new THREE.DirectionalLight(0x7d6ad0, 0.35); fill.position.set(-2.5, 0.8, 2.0);
    const hemi = new THREE.HemisphereLight(0xcfc4ff, 0x1a1028, 0.2);
    studio.add(key, key.target, rimL, rimL.target, rimR, rimR.target, fill, hemi);
  }
  scene.add(toon, studio);
  // soft contact shadow on an invisible floor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ opacity: 0.35 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  // reflections from a neutral studio environment (kept dim: the renders are moody)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // ---- materials ------------------------------------------------------------------------------
  const fabric = fabricTexture(THREE);
  const swaps = [];       // {mesh, toonMat, studioMat}
  vrm.scene.traverse((o) => {
    if (!o.isMesh) return;
    const m = [].concat(o.material)[0];
    if (SCREEN.includes(m.name)) { m.toneMapped = false; return; }     // the 2D face / screen: unlit, exact colours
    const s = SURF[m.name] || { r: 0.6, m: 0 };
    const c = m.color || (m.uniforms && m.uniforms.color && m.uniforms.color.value);
    const col = new THREE.Color(1, 1, 1);
    if (c) col.setRGB(c.x ?? c.r, c.y ?? c.g, c.z ?? c.b).convertSRGBToLinear();   // VRM colours are sRGB
    if (m.map) m.map.encoding = THREE.sRGBEncoding;
    const P = s.cc ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    const nm = new P({
      name: m.name, color: col, map: m.map || null, roughness: s.r, metalness: s.m, envMap: env, envMapIntensity: 0.35,
      transparent: m.transparent, alphaTest: m.alphaTest || 0, side: m.side,
    });
    if (s.cc) { nm.clearcoat = s.cc; nm.clearcoatRoughness = 0.35; }
    if (s.bump) { nm.bumpMap = fabric; nm.bumpScale = 0.0035 * s.bump; nm.roughness = Math.min(1, s.r + 0.05); }
    swaps.push({ mesh: o, toonMat: o.material, studioMat: nm });
    o.castShadow = true; o.receiveShadow = true;
  });

  const api = {
    mode: 'studio',
    set(mode) {
      api.mode = mode;
      const st = mode === 'studio';
      for (const s of swaps) s.mesh.material = st ? s.studioMat : s.toonMat;
      toon.visible = !st; studio.visible = st; floor.visible = st;
      renderer.shadowMap.enabled = st; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = st ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
      renderer.toneMappingExposure = st ? 1.0 : 1;
      renderer.physicallyCorrectLights = false;
      // materials must recompile after tone-mapping / shadow changes
      vrm.scene.traverse((o) => { if (o.isMesh) [].concat(o.material).forEach((m) => (m.needsUpdate = true)); });
    },
    /** keep the contact shadow under the feet */
    update() { const f = vrm.humanoid.getBoneNode('leftFoot'); if (f) floor.position.y = 0.002; },
    dispose() { scene.remove(toon, studio, floor); },
  };
  return api;
}
