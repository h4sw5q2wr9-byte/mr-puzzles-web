import * as THREE from 'three';
import * as Kalidokit from 'kalidokit';
import { Avatar } from './avatar.js?v=20261113.1049-7ed5388';
import { BodyRig, solvePose, solveHands } from './body-rig.js?v=20261113.1049-7ed5388';
import { Tracker } from './tracker.js?v=20261113.1049-7ed5388';
import { categoriesToDict, DEFAULT_TUNING, STYLES } from './face-map.js?v=20261113.1049-7ed5388';
import { FaceDriver, driverInput } from './face-driver.js?v=20261113.1049-7ed5388';
import { saveModel, loadModel, clearModel } from './storage.js?v=20261113.1049-7ed5388';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const TEST = params.has('test');

// ---------------------------------------------------------------- state (persisted per device)
const saved = (() => { try { return JSON.parse(localStorage.getItem('mp-settings') || '{}'); } catch { return {}; } })();
const state = {
  mode: 'face',            // face | upper | full
  facing: 'user',          // user | environment
  poseModel: 'lite',       // lite | full
  delegate: 'GPU',
  mirror: false,           // face left/right: false = not reversed (default); true = inverted
  showFeed: true,
  bg: '#2b2140',
  baseline: null,          // the person's calibrated neutral face (FaceDriver baselines)
  ...saved,
};
// settings from older versions: keep the user's sliders, add the new options with their defaults
state.tuning = { ...DEFAULT_TUNING, ...(saved.v >= 2 ? saved.tuning : { ...(saved.tuning || {}), style: DEFAULT_TUNING.style }) };
// face not reversed by default; settings saved by the reverted phase-2 build (v4) are reset once
if (!(saved.v >= 3) || saved.v >= 4) { state.mirror = false; for (const k of ['view', 'track', 'preview', 'armGain', 'arMode', 'arHide', 'arScale', 'debug', 'perf', 'auto', 'poses', 'lipsync', 'staticFx', 'sweat', 'recAudio', 'recClean']) delete state[k]; }
state.v = 3; delete state.neutral;
const persist = () => { try { localStorage.setItem('mp-settings', JSON.stringify(state)); } catch {} };

// ---------------------------------------------------------------- three.js
const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: TEST, alpha: false });
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TEST ? 1 : 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(state.bg);
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
const key = new THREE.DirectionalLight(0xffffff, 0.75); key.position.set(0.6, 2.2, 3); scene.add(key);
const rim = new THREE.DirectionalLight(0xb48cff, 0.5); rim.position.set(-2, 2, -2); scene.add(rim);
scene.add(new THREE.HemisphereLight(0xe8e0ff, 0x302040, 0.55));
const avatar = new Avatar(scene);
let rig = null;
const camTarget = new THREE.Vector3(0, 1.4, 0), camPos = new THREE.Vector3(0, 1.45, 1.3);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

function frameCamera(dt, snap = false) {
  if (!avatar.vrm) return;
  const head = avatar.vrm.humanoid.getBoneNode('head').getWorldPosition(new THREE.Vector3());
  const hips = avatar.vrm.humanoid.getBoneNode('hips').getWorldPosition(new THREE.Vector3());
  const portrait = camera.aspect < 1;
  let t, dist;
  if (state.mode === 'face') { t = new THREE.Vector3(head.x, head.y + 0.1, 0); dist = portrait ? 1.35 : 0.95; }
  else if (state.mode === 'upper') { t = new THREE.Vector3(hips.x * 0.5, (head.y + hips.y) / 2 + 0.25, 0); dist = portrait ? 4.4 : 2.9; }
  else { t = new THREE.Vector3(hips.x * 0.5, 0.95, 0); dist = portrait ? 5.8 : 4.2; }
  const k = snap ? 1 : 1 - Math.pow(0.02, dt);
  camTarget.lerp(t, k); camPos.lerp(new THREE.Vector3(t.x, t.y + 0.04, dist), k);
  camera.position.copy(camPos); camera.lookAt(camTarget);
}

// ---------------------------------------------------------------- model loading
async function useModel(buf, remember = true) {
  status('Loading avatar…');
  await avatar.load(buf);
  rig = new BodyRig(avatar.vrm);
  if (!avatar.hasPuzzlesFace) toast('This VRM has no Mr. Puzzles face groups – only head/body will move.');
  else if (avatar.missingGroups.length) toast('This is an older Mr. Puzzles model: tap ⚙︎ → Advanced → Use built-in Mr. Puzzles for the new eye shapes.', 9000);
  if (remember) saveModel(buf, { kind: 'custom' }).catch(() => {});
  $('#empty').hidden = true;
  frameCamera(0, true);
  status('');
}
$('#file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await useModel(await f.arrayBuffer()); } catch (err) { console.error(err); toast('Could not load that file: ' + err.message); }
});
// Mr. Puzzles ships with the site (MrPuzzles.vrm + a tiny version file). It is kept on the device and
// only downloaded again when the site's version changes. A model the user imported themselves wins.
async function fetchWithProgress(url, label) {
  const r = await fetch(url);
  if (!r.ok || (r.headers.get('content-type') || '').includes('html')) throw new Error('HTTP ' + r.status);
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !total) return r.arrayBuffer();
  const reader = r.body.getReader(), parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    parts.push(value); got += value.length; status(`${label} ${Math.round(got / total * 100)} %`);
  }
  const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}
async function bootModel() {
  const url = params.get('vrm');
  try {
    if (url) return await useModel(await (await fetch(url)).arrayBuffer(), false);
    const stored = await loadModel();
    if (stored && stored.meta.kind === 'custom') return await useModel(stored.buf, false);
    let version = null;
    try { const r = await fetch('MrPuzzles.version.json', { cache: 'no-cache' }); if (r.ok) version = (await r.json()).version; } catch {}
    if (stored && stored.meta.kind === 'bundled' && (!version || stored.meta.version === version)) return await useModel(stored.buf, false);
    if (version) {
      const buf = await fetchWithProgress('MrPuzzles.vrm?v=' + encodeURIComponent(version), 'Downloading Mr. Puzzles…');
      saveModel(buf, { kind: 'bundled', version }).catch(() => {});
      return await useModel(buf, false);
    }
    if (stored) return await useModel(stored.buf, false);          // offline: use whatever we have
  } catch (e) { console.warn(e); status(''); }
  $('#empty').hidden = false;
}

// ---------------------------------------------------------------- tracking
const tracker = new Tracker();
const video = $('#video');
let stream = null, running = false, lastVideoTime = -1;
const driver = new FaceDriver();
if (state.baseline) { driver.bsBase = { ...state.baseline.bs }; driver.geoBase = state.baseline.geo ? { ...state.baseline.geo } : null; driver.locked = true; }
const stats = { fps: 0, tFps: 0, n: 0, tn: 0, t0: performance.now(), face: false, pose: false };

async function startCamera() {
  if (!avatar.vrm) { toast('Load the Mr. Puzzles .vrm first'); return; }
  try {
    status('Starting camera…');
    stream?.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: state.facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } });
    video.srcObject = stream; await video.play();
    await ensureModels();
    running = true; $('#btn-cam').classList.add('on'); $('#btn-cam').textContent = 'Stop';
    if (!state.baseline) { driver.reset(); setTimeout(() => running && !state.baseline && startCalibration(), 900); }
    status('');
  } catch (e) { console.error(e); status(''); toast('Camera: ' + e.message); }
}
function stopCamera() { running = false; stream?.getTracks().forEach((t) => t.stop()); stream = null; $('#btn-cam').classList.remove('on'); $('#btn-cam').textContent = 'Start'; }
async function ensureModels() {
  await tracker.init({ needPose: state.mode !== 'face', needHands: state.mode !== 'face', poseModel: state.poseModel, delegate: state.delegate, onStatus: status });
}

let lastT = performance.now();
/** one tracking step on an image source (video element / canvas); exported for tests */
function processFrame(src, nowMs, dt) {
  const w = src.videoWidth || src.width, h = src.height && !src.videoHeight ? src.height : src.videoHeight;
  const size = { width: w, height: h };
  const body = state.mode !== 'face';
  const res = tracker.detect(src, nowMs, { pose: body, hands: body });
  const now = nowMs / 1000;
  // face ----------------------------------------------------------------
  const fl = res.face?.faceLandmarks?.[0];
  stats.face = !!fl;
  if (fl) {
    const inp = driverInput(res.face, w / h);
    const r = driver.step(inp, dt, { tuning: state.tuning, mirror: state.mirror });
    if (r.calibrated) finishCalibration();
    avatar.setFace(r.weights, dt, r.mood, { responsiveness: state.tuning.responsiveness, conf: r.conf, pop: (STYLES[state.tuning.style] || STYLES.zamination).pop });
    lastFace = { bs: inp.bs, weights: r.weights, cues: r.cues, mood: r.mood, conf: r.conf };
    const fs = Kalidokit.Face.solve(fl, { runtime: 'mediapipe', imageSize: size, smoothBlink: false });
    const hipsYaw = 0;
    if (fs) rig.applyHead(fs, dt, hipsYaw);
  } else { avatar.setFace(null, dt); rig.relaxHead(dt); }
  // body ----------------------------------------------------------------
  let pose = null, hands = null;
  if (body) {
    pose = solvePose(res.pose, size, state.mode === 'full');
    hands = solveHands(res.hands, res.pose?.landmarks?.[0]);
  }
  stats.pose = !!pose;
  rig.applyBody(pose, hands, { legs: state.mode === 'full', now, dt, moveRoot: state.mode === 'full' });
  if (TEST) window.__last = { pose, hands, face: lastFace, applied: { ...(avatar.applied || {}) }, res: { face: !!fl, pose: !!pose, hands: hands && { L: !!hands.Left, R: !!hands.Right } } };
  return res;
}
let lastFace = null;

function loop() {
  requestAnimationFrame(loop);
  if (window.app && window.app.manual) return;     // automated tests drive frames themselves
  const t = performance.now(), dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
  if (running && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try { processFrame(video, t, dt); stats.tn++; } catch (e) { console.error(e); }
  } else if (!running && rig) {
    avatar.setFace(null, dt); rig.applyBody(null, null, { now: t / 1000, dt });
  }
  avatar.update(dt);
  frameCamera(dt);
  renderer.render(scene, camera);
  stats.n++;
  if (t - stats.t0 > 1000) {
    stats.fps = stats.n * 1000 / (t - stats.t0); stats.tFps = stats.tn * 1000 / (t - stats.t0); stats.n = stats.tn = 0; stats.t0 = t;
    $('#hud').textContent = running ? `${stats.fps.toFixed(0)} fps · tracking ${stats.tFps.toFixed(0)}/s · ${stats.face ? 'face ✓' : 'face –'}${state.mode !== 'face' ? (stats.pose ? ' · body ✓' : ' · body –') : ''}` : '';
  }
}

// ---------------------------------------------------------------- calibration
function startCalibration() {
  if (!running) { toast('Start the camera first'); return; }
  driver.startCalibration(30); toast('Relax your face and look at the screen…', 2500);
}
function finishCalibration() {
  state.baseline = { bs: { ...driver.bsBase }, geo: driver.geoBase ? { ...driver.geoBase } : null }; persist();
  toast('Calibrated ✓ (your resting face is now neutral)');
}

// ---------------------------------------------------------------- recording
let rec = null, chunks = [];
function toggleRecord() {
  if (rec) { rec.stop(); return; }
  const s = canvas.captureStream(30);
  const type = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!type) { toast('Recording not supported in this browser'); return; }
  rec = new MediaRecorder(s, { mimeType: type, videoBitsPerSecond: 6e6 }); chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    const blob = new Blob(chunks, { type }); rec = null; $('#btn-rec').classList.remove('on');
    const file = new File([blob], `mr-puzzles-${Date.now()}.${type.includes('mp4') ? 'mp4' : 'webm'}`, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch {} }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  };
  rec.start(); $('#btn-rec').classList.add('on');
}

// ---------------------------------------------------------------- UI
function status(s) { $('#status').textContent = s; $('#status').hidden = !s; }
let toastT; function toast(s, ms = 3500) { const el = $('#toast'); el.textContent = s; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), ms); }
const SLIDERS = ['intensity', 'eyeIntensity', 'mouthIntensity', 'browIntensity', 'gaze', 'responsiveness', 'shading'];
function syncUI() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  $('#feed').hidden = !state.showFeed; video.classList.toggle('mirror', state.facing === 'user');
  scene.background = new THREE.Color(state.bg);
  for (const k of SLIDERS) { const el = $('#t-' + k); if (el) el.value = state.tuning[k]; }
  $('#o-style').value = state.tuning.style;
  $('#o-mirror').checked = state.mirror; $('#o-feed').checked = state.showFeed; $('#o-mood').checked = state.tuning.autoMoodColor;
  $('#o-green').checked = state.tuning.greenFx;
  $('#o-pose').value = state.poseModel; $('#o-facing').value = state.facing; $('#o-delegate').value = state.delegate; $('#o-bg').value = state.bg;
}
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', async () => {
  state.mode = b.dataset.mode; persist(); syncUI();
  if (state.mode === 'full') toast('Full body: put the phone ~2.5–3 m away so your whole body (head to feet) is in view.', 5000);
  if (running) { status('Loading models…'); await ensureModels(); status(''); }
}));
$('#btn-cam').addEventListener('click', () => (running ? stopCamera() : startCamera()));
$('#btn-cal').addEventListener('click', startCalibration);
$('#btn-rec').addEventListener('click', toggleRecord);
$('#btn-set').addEventListener('click', () => ($('#settings').hidden = !$('#settings').hidden));
$('#btn-load').addEventListener('click', () => $('#file').click());
$('#btn-builtin').addEventListener('click', async () => { await clearModel(); location.reload(); });
$('#empty-load').addEventListener('click', () => $('#file').click());
document.querySelectorAll('[data-tint]').forEach((b) => b.addEventListener('click', () => {
  const t = b.dataset.tint; avatar.manualTint = t === 'auto' ? null : { red: t === 'red' ? 1 : 0, green: t === 'green' ? 1 : 0 };
  document.querySelectorAll('[data-tint]').forEach((x) => x.classList.toggle('on', x === b));
}));
for (const k of SLIDERS) $('#t-' + k)?.addEventListener('input', (e) => { state.tuning[k] = +e.target.value; persist(); });
$('#o-style').addEventListener('change', (e) => { state.tuning.style = e.target.value; persist(); });
$('#o-green').addEventListener('change', (e) => { state.tuning.greenFx = e.target.checked; persist(); });
$('#o-mirror').addEventListener('change', (e) => { state.mirror = e.target.checked; persist(); });
$('#o-feed').addEventListener('change', (e) => { state.showFeed = e.target.checked; persist(); syncUI(); });
$('#o-mood').addEventListener('change', (e) => { state.tuning.autoMoodColor = e.target.checked; persist(); });
$('#o-pose').addEventListener('change', async (e) => { state.poseModel = e.target.value; persist(); if (running) await ensureModels(); });
$('#o-facing').addEventListener('change', async (e) => { state.facing = e.target.value; persist(); syncUI(); if (running) await startCamera(); });
$('#o-delegate').addEventListener('change', (e) => { state.delegate = e.target.value; persist(); toast('Reload the page to apply'); });
$('#o-bg').addEventListener('change', (e) => { state.bg = e.target.value; persist(); syncUI(); });
$('#o-reset').addEventListener('click', () => { state.baseline = null; driver.reset(); state.tuning = { ...DEFAULT_TUNING }; persist(); syncUI(); toast('Reset'); });
document.addEventListener('visibilitychange', () => { if (document.hidden && running) stopCamera(); });

syncUI(); resize(); bootModel(); loop();

// test / automation hooks --------------------------------------------------------------
window.app = {
  state, avatar, tracker, driver, ensureModels, useModel, processFrame, frameCamera,
  get rig() { return rig; },
  render() { avatar.update(1 / 30); frameCamera(1 / 30, true); renderer.render(scene, camera); },
  setMode(m) { state.mode = m; syncUI(); },
};
