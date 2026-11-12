// Mr. Puzzles Mirror - browser AR: MediaPipe Face Landmarker + Three.js, driving the ORIGINAL Mr. Puzzles face rig.
import * as THREE from '../vendor/three/three.module.js';
import { MrPuzzlesRig } from './rig.js';
import { FaceTracker } from './tracker.js';
import { Camera } from './camera.js';
import { PoseFilter } from './pose.js';
import { Baseline, condition } from './mp_map.js';
import { Recorder, extFor } from './recorder.js';
import { compute } from './mood.js';
import { PRESETS, DEMO_SEQUENCE } from './demo_presets.js';
import { loadSettings, saveSettings, DEFAULTS } from './settings.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MP_VFOV = 63;                 // MediaPipe's virtual camera (vertical FOV, degrees) used for the facial transformation matrix
const MOODS = ['auto', 'happy', 'surprise', 'anger', 'sad', 'flustered', 'mischief', 'disgust'];

const S = loadSettings();                                         // persisted user settings
const state = {
  running: false, camera: null, mode: 'photo', mood: 'auto',
  faceFound: false, lastFound: -10, detectMs: 0, fps: 60, frameMs: 16, delegate: '-', capture: null, recording: false,
  forceWeights: null, forcePose: null, loadedModel: false
};

// ------------------------------------------------------------------------------------------------ renderer / scene
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#1a1028');
const camera3d = new THREE.PerspectiveCamera(MP_VFOV, 9 / 16, 5, 2000);
camera3d.position.set(0, 0, 0);

const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-30, 60, 80); scene.add(key);
scene.add(new THREE.HemisphereLight(0xffffff, 0x554466, 0.7));

const anchor = new THREE.Group();                // follows the tracked head (position / rotation / scale)
scene.add(anchor);

const video = $('cam');
const videoTex = new THREE.VideoTexture(video);
videoTex.colorSpace = THREE.SRGBColorSpace; videoTex.minFilter = videoTex.magFilter = THREE.LinearFilter; videoTex.generateMipmaps = false;
videoTex.wrapS = THREE.RepeatWrapping;

const tracker = new FaceTracker();
const poseFilter = new PoseFilter();
const baseline = new Baseline();
const recorder = new Recorder(canvas);
const cam = new Camera(video);
let rig = null;
let videoAspect = 3 / 4;
let bgMirror = true;
let pixelBudget = { high: 1920, balanced: 1280, low: 960 }[S.quality] || 1280;
let budgetScale = 1;

function resize() {
  const w = Math.max(1, Math.round(window.innerWidth)), h = Math.max(1, Math.round(window.innerHeight));
  const dpr = window.devicePixelRatio || 1;
  const pr = Math.min(dpr, (pixelBudget * budgetScale) / Math.max(w, h));
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const screenAspect = w / h;
  // 'cover' fit of the video; the camera's vertical FOV follows the visible part so MediaPipe's pose lines up with the pixels
  let fov = MP_VFOV, rx = 1, ry = 1;
  if (screenAspect <= videoAspect) rx = screenAspect / videoAspect;            // sides cropped, height fits
  else { ry = videoAspect / screenAspect; fov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(MP_VFOV) / 2) * ry) * 180 / Math.PI; }
  camera3d.fov = fov; camera3d.aspect = screenAspect; camera3d.updateProjectionMatrix();
  videoTex.repeat.set(bgMirror ? -rx : rx, ry);
  videoTex.offset.set(bgMirror ? (1 + rx) / 2 : (1 - rx) / 2, (1 - ry) / 2);
  state.pixelRatio = pr;
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);   // iOS Safari toolbar show/hide

// ------------------------------------------------------------------------------------------------ model
async function loadModel() {
  const data = await (await fetch('./data/rig.json')).json();
  rig = await MrPuzzlesRig.load('./models/MrPuzzles_Head.glb', data, renderer, p => setLoading(`Loading Mr. Puzzles… ${Math.round(p * 100)}%`));
  scene.environment = rig.envMap;
  try { rig.addLabelDecal(await new THREE.TextureLoader().loadAsync('./models/label.png')); } catch (e) { console.warn('label decal failed', e); }
  anchor.add(rig.pivot);
  rig.setBodyVisible(S.body);
  state.loadedModel = true;
  if (rig.missing) console.warn('missing bones', rig.missing);
}

function placeRig() {          // user offsets are in head space (cm); TV size is relative
  rig.pivot.position.set(0, S.offsetY, S.offsetZ);
  rig.pivot.scale.setScalar(S.tvSize);
}

// ------------------------------------------------------------------------------------------------ main loop
let last = performance.now(), lastVideoTime = -1, frames = 0, fpsAcc = 0, slowFrames = 0;
const inputWeights = {}, calibrated = {};
const bodyQ = new THREE.Quaternion(), tmpQ = new THREE.Quaternion(), identityQ = new THREE.Quaternion();
let demoClock = 0, demoIndex = 0, demoFrom = {}, demoTo = PRESETS.neutral, demoBlend = 1;
const demoOut = {};

function demoWeights(dt) {
  demoClock += dt;
  const seq = DEMO_SEQUENCE[demoIndex];
  if (demoClock >= seq[1]) { demoClock -= seq[1]; demoIndex = (demoIndex + 1) % DEMO_SEQUENCE.length; demoFrom = demoTo; demoTo = PRESETS[DEMO_SEQUENCE[demoIndex][0]]; demoBlend = 0; }
  demoBlend = Math.min(1, demoBlend + dt / 0.12);
  for (const k in demoOut) demoOut[k] = 0;
  for (const k in demoFrom) demoOut[k] = (demoFrom[k] || 0) * (1 - demoBlend);
  for (const k in demoTo) demoOut[k] = (demoOut[k] || 0) + demoTo[k] * demoBlend;
  return demoOut;
}

function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0.001, (nowMs - last) / 1000)); last = nowMs;   // (capped, but high enough that slow devices do not animate in slow motion)
  const t = nowMs / 1000;
  if (!rig) return;

  let weights = null;
  if (state.running && cam.stream && video.readyState >= 2) {
    // ---- track on every NEW camera frame
    // (adaptive: on a slow device detection is spaced out so the 3D render + recording keep their frame rate)
    if (video.currentTime !== lastVideoTime && tracker.landmarker && nowMs >= (state.nextDetect || 0)) {
      lastVideoTime = video.currentTime;
      const r = tracker.detect(video, nowMs);
      state.detectMs += (r.ms - state.detectMs) * 0.3;
      state.nextDetect = performance.now() + Math.min(250, state.detectMs * 0.6);
      if (r.found) {
        if (!state.faceFound && t - state.lastFound > 0.5) poseFilter.reset();
        state.faceFound = true; state.lastFound = t;
        const p = poseFilter.update(r.matrix, Math.max(0.008, dt), bgMirror);
        state.target = p;
        state.rawWeights = r.weights;
      } else state.faceFound = false;
    }
    if (state.target) {
      // follow the filtered target at display rate (interpolates between 30 Hz detections)
      const k = state.snap ? 1 : 1 - Math.exp(-28 * dt); state.snap = false;
      anchor.position.lerp(state.target.position, k);
      anchor.quaternion.slerp(state.target.quaternion, k);
      anchor.scale.setScalar(THREE.MathUtils.lerp(anchor.scale.x, state.target.scale, k));
    }
    weights = state.rawWeights;
    if (baseline.calibrating && state.faceFound && weights) baseline.feed(weights);
    if (weights) weights = condition(baseline.apply(weights, calibrated));
    // grace period before hiding the TV after a missed detection (longer when detection itself is slow)
    const grace = 0.35 + 2 * Math.min(250, state.detectMs * 0.6) / 1000 + state.detectMs / 1000;
    anchor.visible = state.faceFound || (t - state.lastFound) < grace;
    if (!state.faceFound && (t - state.lastFound) > grace + 0.15) state.snap = true;
  } else if (!state.running) {
    // ---- idle / demo: gently floating TV with the expression demo loop
    anchor.visible = true;
    anchor.position.set(Math.sin(t * 0.6) * 3, Math.sin(t * 0.9) * 1.2, -62);
    anchor.quaternion.setFromEuler(new THREE.Euler(Math.sin(t * 0.7) * 0.08, Math.sin(t * 0.5) * 0.35, Math.sin(t * 0.45) * 0.07));
    anchor.scale.setScalar(1);
    weights = demoWeights(dt);
  }
  if (state.forcePose) { anchor.position.copy(state.forcePose.position); anchor.quaternion.copy(state.forcePose.quaternion); anchor.scale.setScalar(state.forcePose.scale || 1); anchor.visible = true; }
  if (state.forceWeights) weights = state.forceWeights;

  // ---- expressions -> rig
  const out = compute(weights || {}, { mirror: bgMirror, gain: S.expressiveness, manualMood: state.mood === 'auto' ? null : state.mood });
  state.out = out;
  placeRig();
  rig.update(dt, out, { pos: anchor.position, quat: anchor.quaternion, secondary: S.secondary, time: t });
  // the shoulders only follow part of the head rotation (a rigid body swinging with every head roll looks wrong)
  const body = rig.nodes.Body;
  if (body && S.body) { bodyQ.copy(anchor.quaternion); tmpQ.copy(identityQ).slerp(bodyQ, 0.3); body.quaternion.copy(bodyQ).invert().multiply(tmpQ); }

  renderer.render(scene, camera3d);
  state.frameCount = (state.frameCount || 0) + 1;

  // ---- capture in the same task as the render (drawing buffer is valid)
  if (state.capture === 'photo') { state.capture = null; doPhoto(); }

  // ---- stats + adaptive quality
  frames++; fpsAcc += dt;
  if (fpsAcc >= 0.5) {
    state.fps = frames / fpsAcc; frames = 0; fpsAcc = 0;
    if (!state.recording && state.running) {
      if (state.fps < 22) slowFrames++; else slowFrames = Math.max(0, slowFrames - 1);
      if (slowFrames >= 4 && budgetScale > 0.5) { budgetScale = Math.max(0.5, budgetScale * 0.85); slowFrames = 0; resize(); }
    }
    updateHud();
  }
}

// ------------------------------------------------------------------------------------------------ capture
async function doPhoto() {
  try {
    flash();
    const blob = await recorder.photoBlob('image/jpeg', 0.92);
    showReview(blob);
  } catch (e) { toast('Could not take the photo: ' + e.message); }
}

let shutterBusy = false;
async function onShutter() {
  if (shutterBusy) return;
  if (state.mode === 'photo') { state.capture = 'photo'; return; }
  shutterBusy = true;
  try {
    if (!state.recording) {
      await recorder.startVideo({ audio: S.mic });
      state.recording = true; document.body.classList.add('recording'); tickTimer();
    } else await stopRecording();
  } catch (e) { toast(e.message || 'Recording failed'); state.recording = false; document.body.classList.remove('recording'); }
  shutterBusy = false;
}
async function stopRecording() {
  state.recording = false; document.body.classList.remove('recording');
  const blob = await recorder.stopVideo();
  showReview(blob);
}
function tickTimer() {
  if (!state.recording) return;
  const s = recorder.elapsed; $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  if (s >= 60) { stopRecording(); return; }
  setTimeout(tickTimer, 250);
}

let reviewURL = null, reviewBlob = null;
function showReview(blob) {
  reviewBlob = blob;
  if (reviewURL) URL.revokeObjectURL(reviewURL);
  reviewURL = URL.createObjectURL(blob);
  const holder = $('reviewMedia'); holder.innerHTML = '';
  const isVideo = blob.type.startsWith('video');
  const el = document.createElement(isVideo ? 'video' : 'img');
  el.src = reviewURL;
  if (isVideo) { el.controls = true; el.playsInline = true; el.loop = true; el.muted = !S.mic; el.autoplay = true; }
  holder.appendChild(el);
  const name = `mr-puzzles-${Date.now()}.${extFor(blob)}`;
  const dl = $('btnSave'); dl.href = reviewURL; dl.download = name;
  const file = new File([blob], name, { type: blob.type });
  $('btnShare').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  $('btnShare').onclick = async () => { try { await navigator.share({ files: [file], title: 'Mr. Puzzles' }); } catch (e) { if (e.name !== 'AbortError') toast('Sharing failed'); } };
  $('review').classList.add('open');
}
function closeReview() { $('review').classList.remove('open'); $('reviewMedia').innerHTML = ''; }

function flash() { const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }

// ------------------------------------------------------------------------------------------------ UI
let toastTimer = 0;
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms); }
function setLoading(msg) { const el = $('loadMsg'); if (el) el.textContent = msg; }

function updateHud() {
  const hint = $('hint');
  const want = state.running && !state.faceFound && (performance.now() / 1000 - state.lastFound) > 0.5;
  hint.classList.toggle('show', want || baseline.calibrating);
  hint.textContent = baseline.calibrating ? 'Relax your face…' : 'Show your face to the camera';
  const d = $('debug');
  if (!S.debug) { d.hidden = true; return; }
  d.hidden = false;
  const o = state.out, info = renderer.info.render;
  d.textContent = [`${state.fps.toFixed(0)} fps  detect ${state.detectMs.toFixed(1)} ms  ${state.delegate}`,
    `render ${state.pixelRatio ? state.pixelRatio.toFixed(2) : '-'}x  calls ${info.calls}  tris ${info.triangles}`,
    `face ${state.faceFound ? 'yes' : 'no'}  mood ${o ? o.dominant : '-'}  bones ${rig ? rig.stats.bonesMoved : 0}`].join('\n');
}

function buildMoodChips() {
  const emoji = { auto: '✨', happy: '😄', surprise: '😮', anger: '😠', sad: '😢', flustered: '😳', mischief: '😈', disgust: '🤢' };
  const wrap = $('moods');
  for (const m of MOODS) {
    const b = document.createElement('button'); b.className = 'chip' + (m === 'auto' ? ' on' : ''); b.type = 'button';
    b.innerHTML = `<span>${emoji[m]}</span><small>${m === 'auto' ? 'Auto' : m[0].toUpperCase() + m.slice(1)}</small>`;
    b.setAttribute('aria-label', m === 'auto' ? 'Track my face' : 'Force mood ' + m);
    b.onclick = () => { state.mood = m; wrap.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b)); };
    wrap.appendChild(b);
  }
}

function bindSettings() {
  const sliders = { expressiveness: 'sExpr', tvSize: 'sSize', offsetY: 'sY', offsetZ: 'sZ' };
  for (const [k, id] of Object.entries(sliders)) {
    const el = $(id), out = $(id + 'V'); el.value = S[k]; out.textContent = (+S[k]).toFixed(2);
    el.oninput = () => { S[k] = +el.value; out.textContent = (+el.value).toFixed(2); saveSettings(S); };
  }
  const toggles = { mirrorAuto: 'tMirror', body: 'tBody', secondary: 'tSecondary', debug: 'tDebug', mic: 'tMic' };
  for (const [k, id] of Object.entries(toggles)) {
    const el = $(id); el.checked = !!S[k];
    el.onchange = () => { S[k] = el.checked; saveSettings(S); if (k === 'body' && rig) rig.setBodyVisible(S.body); if (k === 'mirrorAuto') applyMirror(); };
  }
  const q = $('sQuality'); q.value = S.quality;
  q.onchange = () => { S.quality = q.value; saveSettings(S); pixelBudget = { high: 1920, balanced: 1280, low: 960 }[S.quality]; budgetScale = 1; resize(); };
  $('btnCalibrate').onclick = () => { closeSettings(); calibrate(); };
  $('btnReset').onclick = () => { Object.assign(S, DEFAULTS); saveSettings(S); baseline.reset(); bindSettings(); if (rig) rig.setBodyVisible(S.body); applyMirror(); resize(); toast('Settings reset'); };
}
function openSettings() { $('settings').classList.add('open'); }
function closeSettings() { $('settings').classList.remove('open'); }

function calibrate() {
  if (!state.running) { toast('Start the camera first'); return; }
  toast('Hold a relaxed, neutral face…', 1600);
  baseline.start();
  setTimeout(() => { if (baseline.n > 5) { baseline.finish(); toast('Calibrated ✓'); } else { baseline.reset(); toast('No face found, try again'); } }, 1400);
}

function applyMirror() {
  const front = cam.mirrored;
  bgMirror = S.mirrorAuto ? front : false;
  resize();
}

// ------------------------------------------------------------------------------------------------ camera start / flip
function explain(e) {
  const n = e && e.name;
  if (!window.isSecureContext) return 'The camera needs a secure (HTTPS) page. Open the https:// address of this site.';
  if (!Camera.supported) return 'This browser does not support camera access. On iPhone use Safari (iOS 15 or newer).';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera permission was denied. On iPhone: Settings → Safari → Camera → Ask/Allow, then reload.';
  if (n === 'NotFoundError') return 'No camera was found on this device.';
  if (n === 'NotReadableError') return 'The camera is in use by another app. Close it and try again.';
  return (e && e.message) || 'Could not start the camera.';
}

async function startCamera() {
  const btn = $('btnStart'); btn.disabled = true; btn.textContent = 'Starting…';
  try {
    if (!Camera.supported || !window.isSecureContext) throw new Error('unsupported');
    const camP = cam.start(cam.facing);                       // must begin inside the tap (iOS user-gesture rule)
    const trackP = tracker.landmarker ? Promise.resolve(tracker.delegate) : tracker.init(setLoading);
    const info = await camP;
    videoAspect = info.width / info.height;
    scene.background = videoTex;
    applyMirror();
    state.delegate = await trackP;
    state.running = true; state.snap = true; lastVideoTime = -1;
    document.body.classList.add('live');
    $('start').classList.add('gone');
    $('btnFlip').hidden = !(cam.devices.length > 1 || /iPhone|iPad|Android/i.test(navigator.userAgent));
  } catch (e) {
    console.error(e);
    $('startError').textContent = explain(e); $('startError').hidden = false;
    btn.disabled = false; btn.textContent = 'Try again';
    cam.stop();
  }
}

async function flipCamera() {
  if (!state.running) return;
  const b = $('btnFlip'); b.disabled = true;
  try {
    state.running = false; state.faceFound = false; state.target = null;
    const info = await cam.flip();
    videoAspect = info.width / info.height; lastVideoTime = -1;
    poseFilter.reset(); state.snap = true;
    applyMirror();
    state.running = true;
    toast(cam.actualFacing === 'environment' ? 'Back camera' : 'Front camera');
  } catch (e) { toast(explain(e)); state.running = true; }
  b.disabled = false;
}

// ------------------------------------------------------------------------------------------------ boot
function bind() {
  buildMoodChips(); bindSettings();
  $('btnStart').onclick = startCamera;
  $('btnFlip').onclick = flipCamera;
  $('btnShutter').onclick = onShutter;
  $('btnSettings').onclick = openSettings; $('btnCloseSettings').onclick = closeSettings;
  $('btnCloseReview').onclick = closeReview;
  document.querySelectorAll('#modeSwitch button').forEach(b => b.onclick = () => {
    if (state.recording) return;
    state.mode = b.dataset.mode; document.body.dataset.mode = state.mode;
    document.querySelectorAll('#modeSwitch button').forEach(x => x.classList.toggle('on', x === b));
  });
  if (!Recorder.videoSupported) { const vb = document.querySelector('#modeSwitch [data-mode="video"]'); vb.disabled = true; vb.title = 'Video recording is not supported in this browser'; }
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.recording) stopRecording(); });
}

async function boot() {
  if (params.get('clean') === '1') document.body.classList.add('clean');
  if (params.get('debug') === '1') S.debug = true;
  bind(); resize();
  try { await loadModel(); } catch (e) { console.error(e); $('startError').textContent = 'Could not load the 3D model: ' + e.message; $('startError').hidden = false; return; }
  placeRig(); resize();
  $('btnStart').disabled = false; $('btnStart').textContent = 'Start camera'; setLoading('');
  document.body.classList.add('ready');
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (params.get('autostart') === '1') startCamera();
  requestAnimationFrame(frame);
}

// test / debugging hooks (used by tools/e2e.js; harmless in production)
window.__mrp = {
  state, S, THREE, get rig() { return rig; }, renderer, anchor, camera3d, tracker, recorder, baseline,
  setWeights(w) { state.forceWeights = w; }, setPose(p) { state.forcePose = p; }, setMood(m) { state.mood = m; },
  resize, startCamera, flipCamera, calibrate, setBackground(c) { scene.background = new THREE.Color(c); },
  setMirror(on) { S.mirrorAuto = false; bgMirror = on; resize(); }
};
boot();
