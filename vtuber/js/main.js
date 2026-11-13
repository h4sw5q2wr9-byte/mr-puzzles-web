import * as THREE from 'three';
import * as Kalidokit from 'kalidokit';
import { Avatar } from './avatar.js';
import { BodyRig, solvePose, solveHands } from './body-rig.js';
import { Tracker } from './tracker.js';
import { mapFace, categoriesToDict, DEFAULT_TUNING } from './face-map.js';
import { saveModel, loadModel } from './storage.js';

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
  mirror: true,
  showFeed: true,
  bg: '#2b2140',
  tuning: { ...DEFAULT_TUNING },
  neutral: null,
  ...saved,
};
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
  if (remember) saveModel(buf).catch(() => {});
  $('#empty').hidden = true;
  frameCamera(0, true);
  status('');
}
$('#file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await useModel(await f.arrayBuffer()); } catch (err) { console.error(err); toast('Could not load that file: ' + err.message); }
});
async function bootModel() {
  const url = params.get('vrm');
  try {
    if (url) return await useModel(await (await fetch(url)).arrayBuffer(), false);
    const stored = await loadModel();
    if (stored) return await useModel(stored, false);
    const r = await fetch('MrPuzzles.vrm');                 // optional: a copy hosted next to the app
    if (r.ok && (r.headers.get('content-type') || '').indexOf('html') < 0) return await useModel(await r.arrayBuffer(), true);
  } catch (e) { console.warn(e); }
  $('#empty').hidden = false;
}

// ---------------------------------------------------------------- tracking
const tracker = new Tracker();
const video = $('#video');
let stream = null, running = false, lastVideoTime = -1, calib = null;
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
    const bs = categoriesToDict(res.face.faceBlendshapes[0].categories);
    if (calib) { calib.push(bs); if (calib.length >= 40) finishCalibration(); }
    const { weights, mood } = mapFace(bs, { mirror: state.mirror, neutral: state.neutral, tuning: state.tuning });
    avatar.setFace(weights, dt, mood);
    lastFace = { bs, weights };
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
  calib = []; toast('Relax your face and look at the screen…', 2500);
}
function finishCalibration() {
  const keys = Object.keys(calib[0]); const n = {};
  for (const k of keys) { const v = calib.map((c) => c[k]).sort((a, b) => a - b); n[k] = v[Math.floor(v.length / 2)]; }
  state.neutral = n; calib = null; persist(); toast('Calibrated ✓ (your resting face is now neutral)');
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
function syncUI() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  $('#feed').hidden = !state.showFeed; video.classList.toggle('mirror', state.facing === 'user');
  scene.background = new THREE.Color(state.bg);
  for (const k of ['intensity', 'eyeIntensity', 'mouthIntensity', 'browIntensity', 'gaze']) { const el = $('#t-' + k); if (el) el.value = state.tuning[k]; }
  $('#o-mirror').checked = state.mirror; $('#o-feed').checked = state.showFeed; $('#o-mood').checked = state.tuning.autoMoodColor;
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
$('#empty-load').addEventListener('click', () => $('#file').click());
document.querySelectorAll('[data-tint]').forEach((b) => b.addEventListener('click', () => {
  const t = b.dataset.tint; avatar.manualTint = t === 'auto' ? null : { red: t === 'red' ? 1 : 0, green: t === 'green' ? 1 : 0 };
  document.querySelectorAll('[data-tint]').forEach((x) => x.classList.toggle('on', x === b));
}));
for (const k of ['intensity', 'eyeIntensity', 'mouthIntensity', 'browIntensity', 'gaze']) $('#t-' + k)?.addEventListener('input', (e) => { state.tuning[k] = +e.target.value; persist(); });
$('#o-mirror').addEventListener('change', (e) => { state.mirror = e.target.checked; persist(); });
$('#o-feed').addEventListener('change', (e) => { state.showFeed = e.target.checked; persist(); syncUI(); });
$('#o-mood').addEventListener('change', (e) => { state.tuning.autoMoodColor = e.target.checked; persist(); });
$('#o-pose').addEventListener('change', async (e) => { state.poseModel = e.target.value; persist(); if (running) await ensureModels(); });
$('#o-facing').addEventListener('change', async (e) => { state.facing = e.target.value; persist(); syncUI(); if (running) await startCamera(); });
$('#o-delegate').addEventListener('change', (e) => { state.delegate = e.target.value; persist(); toast('Reload the page to apply'); });
$('#o-bg').addEventListener('change', (e) => { state.bg = e.target.value; persist(); syncUI(); });
$('#o-reset').addEventListener('click', () => { state.neutral = null; state.tuning = { ...DEFAULT_TUNING }; persist(); syncUI(); toast('Reset'); });
document.addEventListener('visibilitychange', () => { if (document.hidden && running) stopCamera(); });

syncUI(); resize(); bootModel(); loop();

// test / automation hooks --------------------------------------------------------------
window.app = {
  state, avatar, tracker, ensureModels, useModel, processFrame, frameCamera,
  get rig() { return rig; },
  render() { avatar.update(1 / 30); frameCamera(1 / 30, true); renderer.render(scene, camera); },
  setMode(m) { state.mode = m; syncUI(); },
};
