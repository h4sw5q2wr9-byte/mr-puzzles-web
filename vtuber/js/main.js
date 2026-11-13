// PuzzleVision Cam - app shell.
//   views    : Studio (Mr. Puzzles centre stage) | AR Lens (he replaces you on camera) | Replay (photos/videos)
//   tracking : Face | Face + Hands (default) | Full body (experimental)
// LEFT / RIGHT: every solver (MediaPipe blendshapes, Kalidokit head / arms / hands) uses the mirror
// convention, so the app always analyses the horizontal FLIP of what it displays. Result: Mr. Puzzles
// copies the person exactly as shown on screen - in Studio the camera picture is shown un-mirrored, so
// your left = his left (head, face, hands, body alike); in AR Lens the picture is selfie-mirrored and he
// sits on your mirror image. The Mirror setting flips the shown picture (and with it, everything).
import * as THREE from 'three';
import { Avatar } from './avatar.js?v=20261113.1012-a627f0d';
import { BodyRig } from './body-rig.js?v=20261113.1012-a627f0d';
import { Tracker } from './tracker.js?v=20261113.1012-a627f0d';
import { DEFAULT_TUNING } from './face-map.js?v=20261113.1012-a627f0d';
import { Performer, POSE_NAMES } from './performer.js?v=20261113.1012-a627f0d';
import { ARLens } from './ar-lens.js?v=20261113.1012-a627f0d';
import { Replay, expand } from './replay.js?v=20261113.1012-a627f0d';
import { Capture, Voice, stamp } from './capture.js?v=20261113.1012-a627f0d';
import { drawOverlay, fitRect } from './overlay.js?v=20261113.1012-a627f0d';
import { saveModel, loadModel, clearModel } from './storage.js?v=20261113.1012-a627f0d';
import { VERSION } from './version.js?v=20261113.1012-a627f0d';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const TEST = params.has('test'), OBS = params.has('obs');

// ---------------------------------------------------------------- settings (persisted per device)
const saved = (() => { try { return JSON.parse(localStorage.getItem('mp-settings') || '{}'); } catch { return {}; } })();
const DEFAULTS = {
  view: 'studio', track: 'hands', facing: 'user', poseModel: 'lite', delegate: 'GPU', mirror: false,
  preview: 'pip', bg: '#2b2140', baseline: null, armGain: 1.12, lipsync: false, poses: false,
  arMode: 'head', arHide: 'none', arScale: 1, staticFx: true, sweat: true, recAudio: false, recClean: false,
  debug: 'off', perf: false, auto: true,
};
const state = { ...DEFAULTS, ...saved };
state.tuning = { ...DEFAULT_TUNING, ...(saved.v >= 2 ? saved.tuning : { ...(saved.tuning || {}), style: DEFAULT_TUNING.style }) };
if (!(saved.v >= 4)) {             // v4: one left/right convention for everything; Face + Hands is the default
  state.mirror = false; state.track = 'hands'; state.view = 'studio';
  if (saved.showFeed === false) state.preview = 'hidden';
}
for (const k of ['mode', 'showFeed', 'neutral']) delete state[k];
state.v = 4;
if (state.view === 'replay') state.view = 'studio';          // media is not persisted
if (params.get('bg')) state.bg = { transparent: 'transparent', green: '#00b140', blue: '#0047bb' }[params.get('bg')] || '#' + params.get('bg').replace('#', '');
const persist = () => { try { localStorage.setItem('mp-settings', JSON.stringify(state)); } catch {} };

// ---------------------------------------------------------------- three.js
const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: true });
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TEST ? 1 : 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
const key = new THREE.DirectionalLight(0xffffff, 0.75); key.position.set(0.6, 2.2, 3); scene.add(key);
const rim = new THREE.DirectionalLight(0xb48cff, 0.5); rim.position.set(-2, 2, -2); scene.add(rim);
scene.add(new THREE.HemisphereLight(0xe8e0ff, 0x302040, 0.55));
const avatar = new Avatar(scene);
let rig = null;
const camTarget = new THREE.Vector3(0, 1.4, 0), camPos = new THREE.Vector3(0, 1.45, 1.3);
const ar = new ARLens($('#arbg'));
const capture = new Capture(), voice = new Voice();

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  ar.resize();
  for (const c of [$('#ovfull'), $('#ov')]) { const r = c.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2); c.width = Math.round(r.width * d); c.height = Math.round(r.height * d); }
}
new ResizeObserver(resize).observe(canvas); new ResizeObserver(resize).observe($('#preview'));

function frameCamera(dt, snap = false) {
  if (!avatar.vrm || state.view === 'ar') return;
  const head = avatar.vrm.humanoid.getBoneNode('head').getWorldPosition(new THREE.Vector3());
  const hips = avatar.vrm.humanoid.getBoneNode('hips').getWorldPosition(new THREE.Vector3());
  const portrait = camera.aspect < 1;
  let t, dist;
  if (state.track === 'face') { t = new THREE.Vector3(head.x, head.y + 0.1, 0); dist = portrait ? 1.35 : 0.95; }
  else if (state.track === 'hands') { t = new THREE.Vector3(hips.x * 0.5, head.y - 0.32, 0); dist = portrait ? 3.6 : 2.5; }
  else { t = new THREE.Vector3(hips.x * 0.5, 0.95, 0); dist = portrait ? 5.8 : 4.2; }
  const k = snap ? 1 : 1 - Math.pow(0.02, dt);
  camTarget.lerp(t, k); camPos.lerp(new THREE.Vector3(t.x, t.y + 0.04, dist), k);
  camera.position.copy(camPos); camera.lookAt(camTarget);
}

// ---------------------------------------------------------------- model loading
async function useModel(buf, remember = true) {
  status('Loading avatar…');
  await avatar.load(buf);
  rig = new BodyRig(avatar.vrm); rig.armGain = state.armGain;
  if (!avatar.hasPuzzlesFace) toast('This VRM has no Mr. Puzzles face groups – only head/body will move.');
  else if (avatar.missingGroups.length) toast('This is an older Mr. Puzzles model: tap ⚙︎ → Advanced → Use built-in Mr. Puzzles for the new eye shapes.', 9000);
  if (remember) saveModel(buf, { kind: 'custom' }).catch(() => {});
  $('#empty').hidden = true;
  applyView(); frameCamera(0, true);
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
const video = $('#video'), photo = $('#photo');
let stream = null, running = false, lastVideoTime = -1;
const performer = new Performer({ avatar, getRig: () => rig, state });
if (state.baseline) { const d = performer.driver; d.bsBase = { ...state.baseline.bs }; d.geoBase = state.baseline.geo ? { ...state.baseline.geo } : null; d.locked = true; }
const stats = { fps: 0, tFps: 0, n: 0, tn: 0, t0: performance.now(), slow: 0, poseEvery: 1 };
let lastRes = null, lastSnap = null, lastMask = null, lastConf;

/** what is SHOWN is selfie-mirrored? (the analysis frame is always the opposite) */
function displayMirrored() {
  if (state.view === 'ar') return (state.facing === 'user') !== state.mirror;
  return state.mirror;
}
// analysis frame = horizontal flip of the displayed picture (see the header comment)
const acan = document.createElement('canvas'), actx = acan.getContext('2d');
function analysisFrame(src) {
  const iw = src.videoWidth || src.naturalWidth || src.width, ih = src.videoHeight || src.naturalHeight || src.height;
  const k = Math.min(1, 640 / Math.max(iw, ih)), w = Math.round(iw * k), h = Math.round(ih * k);
  if (acan.width !== w || acan.height !== h) { acan.width = w; acan.height = h; }
  actx.setTransform(1, 0, 0, 1, 0, 0);
  if (!displayMirrored()) { actx.translate(w, 0); actx.scale(-1, 1); }
  actx.drawImage(src, 0, 0, w, h);
  return acan;
}

function modules() {
  const body = state.track !== 'face' || (state.view === 'ar' && state.arMode !== 'head');
  return { pose: body, hands: state.track !== 'face', seg: state.view === 'ar' && state.arHide !== 'none' };
}
async function ensureModels() {
  const m = modules();
  try { await tracker.init({ needPose: m.pose, needHands: m.hands, needSeg: m.seg, poseModel: state.poseModel, delegate: state.delegate, onStatus: status }); }
  catch (e) {
    console.error(e);
    if (state.track !== 'face') { state.track = 'face'; syncUI(); toast('Hand / body tracking is not available on this device – using Face only.', 5000); await tracker.init({ needPose: false, needHands: false, delegate: state.delegate, onStatus: status }); }
    else throw e;
  }
}

async function startCamera() {
  if (!avatar.vrm) { toast('Mr. Puzzles is still loading…'); return; }
  if (state.view === 'replay') setView('studio');
  try {
    status('Starting camera…');
    stream?.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: state.facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } });
    video.removeAttribute('src'); video.srcObject = stream; video.hidden = false; photo.hidden = true; await video.play();
    await ensureModels();
    running = true; $('#btn-cam').classList.add('on'); $('#btn-cam').textContent = 'Stop';
    if (state.lipsync) voice.start().catch(() => toast('Microphone not available – voice mouth is off'));
    if (!state.baseline) { performer.driver.reset(); setTimeout(() => running && !state.baseline && startCalibration(), 900); }
    status(''); applyView();
  } catch (e) { console.error(e); status(''); toast('Camera: ' + e.message); }
}
function stopCamera() {
  running = false; stream?.getTracks().forEach((t) => t.stop()); stream = null; voice.stop();
  $('#btn-cam').classList.remove('on'); $('#btn-cam').textContent = 'Start';
}

/** one tracking step on an image source (video element / canvas / image); exported for tests */
function processFrame(src, nowMs, dt) {
  const A = analysisFrame(src);
  const m = modules();
  const res = tracker.detect(A, nowMs, { ...m, poseEvery: stats.poseEvery });
  const snap = performer.track(res, { width: A.width, height: A.height }, { track: state.track, now: nowMs / 1000, dt });
  if (snap.face?.calibrated) finishCalibration();
  performer.voice = state.lipsync ? voice.read(dt) : 0;
  performer.apply(snap, dt, { track: state.track, now: nowMs / 1000, arMode: state.view === 'ar' ? state.arMode : null });
  if (res.seg) lastMask = res.seg;
  lastRes = res; lastSnap = snap; lastConf = snap.face?.conf;
  if (TEST) window.__last = { snap, applied: { ...(avatar.applied || {}) }, res: { face: !!snap.face, pose: !!snap.body, hands: snap.hands && { L: !!snap.hands.Left, R: !!snap.hands.Right } } };
  return res;
}

// ---------------------------------------------------------------- replay
const replay = new Replay({ tracker, state, avatar, getRig: () => rig, analysisFrame, onStatus: status, onProgress: (p) => ($('#scrub').value = p) });
$('#btn-import').addEventListener('click', () => $('#media').click());
$('#media').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  stopCamera(); video.pause();
  try {
    await replay.load(f, video, photo);
    $('#btn-play').textContent = '▶︎'; $('#scrub').value = 0; applyView();
    toast(replay.kind === 'photo' ? 'Photo pose ready – 📷 saves it as PNG' : 'Ready – press ▶︎', 3000);
  } catch (err) { console.error(err); status(''); toast(err.message); }
});
$('#btn-play').addEventListener('click', () => {
  if (replay.kind !== 'video') return;
  if (video.paused) { if (video.ended) video.currentTime = 0; video.play(); } else video.pause();
});
video.addEventListener('play', () => ($('#btn-play').textContent = '❚❚'));
video.addEventListener('pause', () => ($('#btn-play').textContent = '▶︎'));
$('#btn-restart').addEventListener('click', () => { if (replay.kind === 'video') { video.currentTime = 0; video.play(); } });
$('#scrub').addEventListener('input', (e) => { if (replay.kind === 'video' && !replay.busy) video.currentTime = +e.target.value * video.duration; });

// ---------------------------------------------------------------- render loop
let lastT = performance.now();
function loop() {
  requestAnimationFrame(loop);
  if (window.app && window.app.manual) return;     // automated tests drive frames themselves
  const t = performance.now(), dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
  if (state.view === 'replay' && replay.frames.length && !replay.busy && rig) {
    const mt = replay.kind === 'video' ? video.currentTime : 0;
    const snap = replay.at(mt);
    performer.apply(snap, dt, { track: state.track, now: mt, exact: true });
    lastRes = expand(snap.res); lastConf = snap.face?.conf;
    if (replay.kind === 'video') { $('#scrub').value = mt / (video.duration || 1); $('#rtime').textContent = `${fmt(mt)} / ${fmt(video.duration)}`; }
  } else if (running && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try { processFrame(video, t, dt); stats.tn++; } catch (e) { console.error(e); }
  } else if (!running && state.view !== 'replay' && rig) {
    performer.apply({ face: null }, dt, { track: 'face', now: t / 1000 });
  }
  render(dt);
  stats.n++;
  if (t - stats.t0 > 1000) { perfTick(t); }
}
function render(dt, snapCam = false) {
  avatar.update(dt);
  if (state.view === 'ar' && running && avatar.vrm) {
    ar.drawBackground(video, displayMirrored(), lastMask, state.arHide);
    if (lastSnap) ar.placeAvatar(avatar, lastSnap, lastRes || {}, state.arMode, state.arScale, dt);
    renderer.setClearColor(0x000000, 0); scene.background = null;
    renderer.render(scene, ar.cam);
  } else {
    frameCamera(dt, snapCam);
    scene.background = state.bg === 'transparent' ? null : new THREE.Color(state.bg);
    renderer.setClearColor(0x000000, 0);
    renderer.render(scene, camera);
  }
  drawDebug();
  if (capture.recording) composeFrame();
}

// ---------------------------------------------------------------- tracking view + performance
function mediaEl() { return state.view === 'replay' && replay.kind === 'photo' ? photo : video; }
function drawDebug() {
  const full = $('#ovfull'), small = $('#ov');
  const fctx = full.getContext('2d'), sctx = small.getContext('2d');
  fctx.clearRect(0, 0, full.width, full.height); sctx.clearRect(0, 0, small.width, small.height);
  if (state.debug === 'off' || !lastRes) return;
  const el = mediaEl(), iw = el.videoWidth || el.naturalWidth, ih = el.videoHeight || el.naturalHeight;
  if (!iw) return;
  if (state.view === 'ar') {
    if (!ar.rect) return;
    const d = full.width / full.clientWidth;
    drawOverlay(fctx, { x: ar.rect.x * d, y: ar.rect.y * d, w: ar.rect.w * d, h: ar.rect.h * d }, lastRes, state.debug, { conf: lastConf });
  } else if (state.preview !== 'hidden') {
    drawOverlay(sctx, fitRect(iw, ih, small.width, small.height), lastRes, state.debug, { conf: lastConf });
  } else {
    // preview hidden: draw the camera view small in the corner of the full overlay
    const d = full.width / full.clientWidth, w = 200 * d, h = w * ih / iw;
    fctx.globalAlpha = 0.9; fctx.save();
    if (displayMirrored()) { fctx.translate(10 * d + w, 60 * d); fctx.scale(-1, 1); fctx.drawImage(el, 0, 0, w, h); } else fctx.drawImage(el, 10 * d, 60 * d, w, h);
    fctx.restore(); fctx.globalAlpha = 1;
    drawOverlay(fctx, { x: 10 * d, y: 60 * d, w, h }, lastRes, state.debug, { conf: lastConf });
  }
}
function perfTick(t) {
  stats.fps = stats.n * 1000 / (t - stats.t0); stats.tFps = stats.tn * 1000 / (t - stats.t0); stats.n = stats.tn = 0; stats.t0 = t;
  // adaptive quality: Face + Hands / Full body on a slow device -> body model every other frame -> Face only
  if (running && state.auto && state.track !== 'face') {
    stats.slow = stats.tFps < 8 ? stats.slow + 1 : Math.max(0, stats.slow - 1);
    if (stats.slow >= 4 && stats.poseEvery === 1) { stats.poseEvery = 2; stats.slow = 0; }
    else if (stats.slow >= 5 && stats.poseEvery === 2) {
      stats.poseEvery = 1; stats.slow = 0; state.track = 'face'; syncUI(); persist();
      toast('This device was too slow for hand tracking – switched to Face only (tap Face + Hands to try again).', 6000);
    }
  }
  const m = modules(), ms = tracker.ms;
  $('#hud').textContent = !state.perf ? (running && !lastSnap?.face ? 'looking for your face…' : '')
    : `${stats.fps.toFixed(0)} fps · tracking ${stats.tFps.toFixed(0)}/s\nface ${ms.face.toFixed(0)}ms${m.hands ? ` · hands ${ms.hands.toFixed(0)}ms` : ''}${m.pose ? ` · body ${ms.pose.toFixed(0)}ms${stats.poseEvery > 1 ? ' (½)' : ''}` : ''}${m.seg ? ` · mask ${ms.seg.toFixed(0)}ms` : ''}\n${lastSnap?.face ? 'face ✓' : 'face –'}${m.hands ? (lastSnap?.hands?.Left || lastSnap?.hands?.Right ? ' · hands ✓' : ' · hands –') : ''}${m.pose ? (lastSnap?.body ? ' · body ✓' : ' · body –') : ''}`;
}

// ---------------------------------------------------------------- calibration
function startCalibration() {
  if (!running) { toast('Start the camera first'); return; }
  performer.driver.startCalibration(30); toast('Relax your face and look at the screen…', 2500);
}
function finishCalibration() {
  const d = performer.driver;
  state.baseline = { bs: { ...d.bsBase }, geo: d.geoBase ? { ...d.geoBase } : null }; persist();
  toast('Calibrated ✓ (your resting face is now neutral)');
}

// ---------------------------------------------------------------- capture
function composeFrame(scale = 1) {
  const W = innerWidth, H = innerHeight;
  const layers = [];
  const stageR = canvas.getBoundingClientRect();
  if (state.view === 'ar') {
    layers.push({ img: $('#arbg'), rect: { x: 0, y: 0, w: W, h: H } });
  } else if ($('body').classList.contains('side')) {
    const pr = $('#preview').getBoundingClientRect(), el = mediaEl(), iw = el.videoWidth || el.naturalWidth, ih = el.videoHeight || el.naturalHeight;
    if (iw) { const r = fitRect(iw, ih, pr.width, pr.height); layers.push({ img: el, rect: { x: pr.x + r.x, y: pr.y + r.y, w: r.w, h: r.h }, mirror: displayMirrored() }); }
  }
  layers.push({ img: canvas, rect: { x: stageR.x, y: stageR.y, w: stageR.width, h: stageR.height } });
  const opaque = state.view === 'ar' ? null : state.bg === 'transparent' ? null : state.bg;
  return capture.compose(layers, W, H, scale, opaque);
}
$('#btn-shot').addEventListener('click', async () => {
  const c = composeFrame(Math.min(3, Math.max(1, devicePixelRatio || 1)));
  await capture.screenshot(c, `mr-puzzles-${stamp()}.png`);
});
$('#btn-rec').addEventListener('click', async () => {
  if (capture.recording) return stopRecording();
  try {
    composeFrame(); await capture.start(state.recAudio);
    if (capture.micError) toast('Recording without sound (microphone not allowed)');
    $('#btn-rec').classList.add('on'); $('#btn-rec').textContent = '■ Stop';
    if (state.recClean) { document.body.classList.add('clean'); toast('Recording – tap anywhere to stop', 2500); }
  } catch (e) { toast(e.message); }
});
async function stopRecording() {
  document.body.classList.remove('clean'); if (OBS) document.body.classList.add('clean');
  $('#btn-rec').classList.remove('on'); $('#btn-rec').textContent = '● Rec';
  await capture.stop();
}
canvas.addEventListener('click', () => { if (capture.recording && state.recClean) stopRecording(); });

// ---------------------------------------------------------------- UI
function status(s) { $('#status').textContent = s; $('#status').hidden = !s; }
let toastT; function toast(s, ms = 3500) { const el = $('#toast'); el.textContent = s; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), ms); }
const fmt = (t) => (isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');
const SLIDERS = ['intensity', 'eyeIntensity', 'mouthIntensity', 'browIntensity', 'gaze', 'responsiveness', 'shading'];
const CHECKS = { 'o-mirror': 'mirror', 'o-lipsync': 'lipsync', 'o-poses': 'poses', 'o-static': 'staticFx', 'o-sweat': 'sweat', 'o-recAudio': 'recAudio', 'o-recClean': 'recClean', 'o-perf': 'perf', 'o-auto': 'auto' };
const SELECTS = { 'o-facing': 'facing', 'o-preview': 'preview', 'o-bg': 'bg', 'o-arMode': 'arMode', 'o-arHide': 'arHide', 'o-debug': 'debug', 'o-pose': 'poseModel', 'o-delegate': 'delegate' };
function applyView() {
  const b = document.body;
  b.classList.toggle('ar', state.view === 'ar'); b.classList.toggle('replay', state.view === 'replay');
  b.classList.toggle('side', state.view !== 'ar' && (state.preview === 'side' || (state.view === 'replay' && state.preview !== 'hidden')));
  b.classList.toggle('poses', state.poses);
  const pv = $('#preview'); pv.className = state.preview === 'large' ? 'large' : 'pip';
  pv.hidden = state.view === 'ar' || state.preview === 'hidden' || (state.view !== 'replay' && !running);
  for (const el of [video, photo]) el.classList.toggle('mirror', displayMirrored());
  if (avatar.vrm) {
    avatar.setBodyVisible(!(state.view === 'ar' && state.arMode === 'head'));
    if (state.view !== 'ar') { avatar.vrm.scene.position.set(0, 0, 0); avatar.vrm.scene.scale.setScalar(1); ar.place = null; }
  }
  $('#btn-cam').hidden = state.view === 'replay'; $('#btn-cal').hidden = state.view === 'replay';
  if (rig) rig.armGain = state.armGain;
  resize();
}
function syncUI() {
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
  document.querySelectorAll('[data-track]').forEach((b) => b.classList.toggle('on', b.dataset.track === state.track));
  for (const k of SLIDERS) { const el = $('#t-' + k); if (el) el.value = state.tuning[k]; }
  $('#o-style').value = state.tuning.style; $('#o-mood').checked = state.tuning.autoMoodColor; $('#o-green').checked = state.tuning.greenFx;
  for (const [id, k] of Object.entries(CHECKS)) $('#' + id).checked = !!state[k];
  for (const [id, k] of Object.entries(SELECTS)) $('#' + id).value = state[k];
  $('#o-armGain').value = state.armGain; $('#o-arScale').value = state.arScale;
  applyView();
}
async function setView(v) {
  state.view = v; persist(); syncUI();
  if (v === 'replay') { stopCamera(); if (!replay.frames.length) toast('Import a photo or video to replay it with Mr. Puzzles', 3500); }
  else if (v === 'ar') { if (!running) await startCamera(); else await ensureModels(); toast('AR Lens: Mr. Puzzles replaces you. ⚙︎ → AR Lens for head / upper body and hiding yourself.', 4500); }
  else if (replay.kind) { video.pause(); }
}
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
document.querySelectorAll('[data-track]').forEach((b) => b.addEventListener('click', async () => {
  state.track = b.dataset.track; stats.poseEvery = 1; stats.slow = 0; persist(); syncUI();
  if (state.track === 'full') toast('Full body (experimental): put the phone ~2.5–3 m away so your whole body is in view.', 5000);
  if (state.track === 'hands') toast('Face + Hands: keep your hands and shoulders in view.', 3000);
  if (running) { status('Loading models…'); await ensureModels(); status(''); }
  else if (state.view === 'replay' && replay.kind) toast('Import the media again to re-analyse it with this tracking mode');
}));
document.querySelectorAll('[data-pose]').forEach((b) => b.addEventListener('click', () => performer.triggerPose(b.dataset.pose)));
$('#btn-cam').addEventListener('click', () => (running ? stopCamera() : startCamera()));
$('#btn-cal').addEventListener('click', startCalibration);
$('#btn-set').addEventListener('click', () => ($('#settings').hidden = !$('#settings').hidden));
$('#btn-load').addEventListener('click', () => $('#file').click());
$('#btn-builtin').addEventListener('click', async () => { await clearModel(); location.reload(); });
$('#empty-load').addEventListener('click', (e) => { e.preventDefault(); $('#file').click(); });
document.querySelectorAll('[data-tint]').forEach((b) => b.addEventListener('click', () => {
  const t = b.dataset.tint; avatar.manualTint = t === 'auto' ? null : { red: t === 'red' ? 1 : 0, green: t === 'green' ? 1 : 0 };
  document.querySelectorAll('[data-tint]').forEach((x) => x.classList.toggle('on', x === b));
}));
for (const k of SLIDERS) $('#t-' + k)?.addEventListener('input', (e) => { state.tuning[k] = +e.target.value; persist(); });
$('#o-style').addEventListener('change', (e) => { state.tuning.style = e.target.value; persist(); });
$('#o-green').addEventListener('change', (e) => { state.tuning.greenFx = e.target.checked; persist(); });
$('#o-mood').addEventListener('change', (e) => { state.tuning.autoMoodColor = e.target.checked; persist(); });
$('#o-armGain').addEventListener('input', (e) => { state.armGain = +e.target.value; persist(); applyView(); });
$('#o-arScale').addEventListener('input', (e) => { state.arScale = +e.target.value; persist(); });
for (const [id, k] of Object.entries(CHECKS)) $('#' + id).addEventListener('change', async (e) => {
  state[k] = e.target.checked; persist(); applyView();
  if (k === 'lipsync') { if (state.lipsync && running) voice.start().catch(() => toast('Microphone not available')); else if (!state.lipsync) voice.stop(); }
});
for (const [id, k] of Object.entries(SELECTS)) $('#' + id).addEventListener('change', async (e) => {
  state[k] = e.target.value; persist(); applyView();
  if (k === 'facing' && running) await startCamera();
  if ((k === 'arMode' || k === 'arHide' || k === 'poseModel') && running) await ensureModels();
  if (k === 'delegate') toast('Reload the page to apply');
});
$('#o-reset').addEventListener('click', () => {
  const keep = { view: state.view }; Object.assign(state, DEFAULTS, keep); state.tuning = { ...DEFAULT_TUNING }; state.baseline = null;
  performer.driver.reset(); persist(); syncUI(); toast('Reset');
});
// drag the floating camera preview anywhere
(() => {
  const pv = $('#preview'); let d = null;
  pv.addEventListener('pointerdown', (e) => { if (document.body.classList.contains('side')) return; d = { x: e.clientX - pv.offsetLeft, y: e.clientY - pv.offsetTop }; pv.setPointerCapture(e.pointerId); });
  pv.addEventListener('pointermove', (e) => { if (!d) return; pv.style.left = Math.max(0, Math.min(innerWidth - pv.offsetWidth, e.clientX - d.x)) + 'px'; pv.style.top = Math.max(0, Math.min(innerHeight - pv.offsetHeight, e.clientY - d.y)) + 'px'; });
  pv.addEventListener('pointerup', () => (d = null));
})();
// keyboard (desktop / OBS): space start-stop, C calibrate, 1-7 poses, H hide UI
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === ' ') { e.preventDefault(); running ? stopCamera() : startCamera(); }
  else if (e.key === 'c') startCalibration();
  else if (e.key === 'h') document.body.classList.toggle('clean');
  else if (/^[1-7]$/.test(e.key)) performer.triggerPose(POSE_NAMES[+e.key - 1]);
});
document.addEventListener('visibilitychange', () => { if (document.hidden && running) stopCamera(); });
$('#version').textContent = 'Version ' + VERSION;
if (OBS) document.body.classList.add('clean');

syncUI(); resize(); bootModel(); loop();
if (OBS) setTimeout(() => startCamera(), 1500);

// test / automation hooks --------------------------------------------------------------
window.app = {
  state, avatar, tracker, performer, replay, ensureModels, useModel, processFrame, frameCamera, analysisFrame, applyView, setView, composeFrame,
  get rig() { return rig; }, THREE, scene, camera, renderer, ar,
  render(dt = 1 / 30) { render(dt, true); },
  set running(v) { running = v; },
  setMode(m) { state.track = m === 'upper' ? 'hands' : m; syncUI(); },
};
