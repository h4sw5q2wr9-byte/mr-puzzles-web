import * as THREE from 'three';
import * as Kalidokit from 'kalidokit';
import { Avatar } from './avatar.js?v=20261114.2057-63f8810';
import { BodyRig, solvePose, solveHands } from './body-rig.js?v=20261114.2057-63f8810';
import { Tracker } from './tracker.js?v=20261114.2057-63f8810';
import { categoriesToDict, DEFAULT_TUNING, STYLES } from './face-map.js?v=20261114.2057-63f8810';
import { FaceDriver, driverInput } from './face-driver.js?v=20261114.2057-63f8810';
import { saveModel, loadModel, clearModel } from './storage.js?v=20261114.2057-63f8810';
import { installLook } from './look.js?v=20261114.2057-63f8810';
import { Voice } from './voice.js?v=20261114.2057-63f8810';
import { TvController } from './tv.js?v=20261114.2057-63f8810';
import { POSES, PosePlayer } from './poses.js?v=20261114.2057-63f8810';
import { drawTracking } from './overlay.js?v=20261114.2057-63f8810';
import { buildSettings } from './settings.js?v=20261114.2057-63f8810';
import { PerfManager } from './perf.js?v=20261114.2057-63f8810';
import { MODEL_CACHE } from './tracker.js?v=20261114.2057-63f8810';

const $ = (s) => document.querySelector(s);
// load-time marks (ms since navigation): see app.timings
const timings = { script: Math.round(performance.now()) };
const mark = (k) => { if (!(k in timings)) timings[k] = Math.round(performance.now()); };
const params = new URLSearchParams(location.search);
const TEST = params.has('test');

// ---------------------------------------------------------------- state (persisted per device)
const saved = (() => { try { return JSON.parse(localStorage.getItem('mp-settings') || '{}'); } catch { return {}; } })();
const state = {
  mode: 'face',            // face | upper | full
  facing: 'user',          // user | environment
  poseModel: 'lite',       // lite | full
  delegate: 'GPU',
  mirror: true,            // face left/right: inverted by default ("Invert face left/right" on)
  showFeed: true,
  bg: '#2b2140',
  look: 'medium',           // quality: low (flat) | medium (lit) | high (rendered look)
  baseline: null,          // the person's calibrated neutral face (FaceDriver baselines)
  ...saved,
};
// settings from older versions: keep the user's sliders, add the new options with their defaults
// TV: stand-by card when no face, glitches on head shake, optional CRT scanlines
state.tv = { standby: true, glitches: true, crt: false, ...(saved.tv || {}) };
// body: 3D aiming solver, depth from arm length, arm smoothing, hand / finger tracking
state.body = { solver: 'aim', lift: true, follow: 0.75, hands: true, ...(saved.body || {}) };
if (state.voiceStrength == null) state.voiceStrength = 1;
state.tuning = { ...DEFAULT_TUNING, ...(saved.v >= 2 ? saved.tuning : { ...(saved.tuning || {}), style: DEFAULT_TUNING.style }) };
// settings saved by the reverted phase-2 build (v4) are cleaned up once
if (!(saved.v >= 3) || saved.v === 4) { for (const k of ['view', 'track', 'preview', 'armGain', 'arMode', 'arHide', 'arScale', 'debug', 'perf', 'auto', 'poses', 'lipsync', 'staticFx', 'sweat', 'recAudio', 'recClean']) delete state[k]; }
// v5: the face is inverted by default -> switch it on once for everyone
if (!(saved.v >= 5)) state.mirror = true;
state.v = 5; delete state.neutral;
state.perf = { auto: true, ...(saved.perf || {}) };
// automated tests run on a slow software GPU: no automatic downgrades unless a test asks for them
if (TEST && !saved.perf) state.perf.auto = false;
// camera preview: off | camera | overlay (camera + what the tracker sees) | tracking (tracker only)
// (after the migration above: an old version used the key 'preview' for something else)
state.preview = { mode: saved.showFeed === false ? 'off' : 'camera', size: 'small', ...(saved.v >= 5 && saved.preview && saved.preview.mode ? saved.preview : {}) };
const persist = () => { try { localStorage.setItem('mp-settings', JSON.stringify(state)); } catch {} };

// ---------------------------------------------------------------- three.js
const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: TEST, alpha: true });   // alpha: transparent background for OBS
renderer.setClearColor(0x000000, 0);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TEST ? 1 : 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
// lights + materials come from look.js (Studio = lit like the Blender renders, Toon = flat VRM look)
let look = null;
if (state.look === 'studio') state.look = 'medium'; else if (state.look === 'toon') state.look = 'low';
const avatar = new Avatar(scene);
const voice = new Voice(); avatar.voice = voice; voice.tvVoice = !!state.tvVoice;
const tv = new TvController();
const poser = new PosePlayer(); avatar.poser = poser;
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

// ---------------------------------------------------------------- startup screen + tracker chip
const bootEl = $('#boot');
function bootRow(k, text, cls = '') { const li = bootEl.querySelector(`li[data-k="${k}"]`); if (!li) return; li.className = cls; li.querySelector('span').textContent = text; }
const neededTracker = (k) => k === 'face' || (state.mode !== 'face' && (k === 'pose' || (k === 'hand' && state.body.hands)));
const TNAME = { face: 'Face', pose: 'Body', hand: 'Hands' };
function trackerText(k) {
  const st = tracker.status[k], need = neededTracker(k);
  switch (st.state) {
    case 'downloading': return [st.total ? `downloading ${Math.round(st.got / st.total * 100)} %` : 'downloading…', ''];
    case 'downloaded': return [need ? 'downloaded, starting soon' : 'downloaded (used in body modes)', need ? '' : 'later'];
    case 'starting': return ['starting…', ''];
    case 'ready': return ['ready', 'ready'];
    case 'failed': return ['failed', 'failed'];
    default: return [need ? 'waiting' : (k === 'hand' && !state.body.hands ? 'off' : 'not needed in Face mode'), need ? '' : 'later'];
  }
}
let booted = false, chipT = 0;
function refreshTrackerUI() {
  for (const k of ['face', 'pose', 'hand']) { const [t, c] = trackerText(k); bootRow(k, t, c); }
  const chip = $('#chip');
  if (!booted) return;
  const need = ['face', 'pose', 'hand'].filter(neededTracker);
  const allReady = need.every((k) => ['ready', 'failed'].includes(tracker.status[k].state));
  if (allReady) { clearTimeout(chipT); chipT = setTimeout(() => chip.classList.add('done'), 1500); }
  else { clearTimeout(chipT); chip.hidden = false; chip.classList.remove('done'); }
  chip.textContent = need.map((k) => { const st = tracker.status[k]; return TNAME[k] + ' ' + (st.state === 'ready' ? '✓' : st.state === 'failed' ? '✕' : st.state === 'downloading' && st.total ? Math.round(st.got / st.total * 100) + '%' : '…'); }).join(' · ');
}
function bootDone() {
  if (booted) return; booted = true;
  bootRow('avatar', 'ready', 'ready');
  if (TEST) bootEl.remove(); else { bootEl.classList.add('gone'); setTimeout(() => bootEl.remove(), 600); }
  refreshTrackerUI();
}
function bootFailed(msg) { bootRow('avatar', msg || 'failed', 'failed'); $('#bootnote').textContent = 'The avatar could not be loaded.'; setTimeout(() => { bootEl.classList.add('gone'); setTimeout(() => bootEl.remove(), 600); }, 1500); }

// ---------------------------------------------------------------- model loading
async function useModel(buf, remember = true) {
  status('Loading avatar…');
  mark('vrmBytes');
  bootRow('avatar', 'building…');
  // the tracking models download while the avatar is being built (network only, no CPU)
  if (!TEST) tracker.prefetch({ needPose: state.mode !== 'face', needHands: state.mode !== 'face' && state.body.hands, poseModel: state.poseModel });
  await avatar.load(buf);
  mark('vrmParsed');
  rig = new BodyRig(avatar.vrm); Object.assign(rig.opts, state.body);
  look?.dispose(); look = installLook(THREE, { renderer, scene, vrm: avatar.vrm }); look.set(state.look); applyBackground();
  tv.reset(wantStandby()); headQValid = false;
  look.pixelCap = null; applyPerf(); perf.hold(6000);
  prepQueue = ['low', 'medium', 'high'].filter((m) => m !== look.mode);
  if (!avatar.hasPuzzlesFace) toast('This VRM has no Mr. Puzzles face groups – only head/body will move.');
  else if (avatar.missingGroups.length) toast('This is an older Mr. Puzzles model: tap ⚙︎ → Advanced → Use built-in Mr. Puzzles for the new eye shapes.', 9000);
  if (remember) saveModel(buf, { kind: 'custom' }).catch(() => {});
  $('#empty').hidden = true;
  frameCamera(0, true);
  status('');
  warmUp();
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
    parts.push(value); got += value.length; if (booted) status(`${label} ${Math.round(got / total * 100)} %`); bootRow('avatar', `downloading ${Math.round(got / total * 100)} %`);
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
    if (stored && stored.meta.kind === 'bundled' && (!version || stored.meta.version === version)) { bootRow('avatar', 'from this device'); return await useModel(stored.buf, false); }
    if (version) {
      const buf = await fetchWithProgress('MrPuzzles.vrm?v=' + encodeURIComponent(version), 'Downloading Mr. Puzzles…');
      saveModel(buf, { kind: 'bundled', version }).catch(() => {});
      return await useModel(buf, false);
    }
    if (stored) return await useModel(stored.buf, false);          // offline: use whatever we have
  } catch (e) { console.warn(e); status(''); }
  bootFailed();
  $('#empty').hidden = false;
}

// ---------------------------------------------------------------- tracking
const tracker = new Tracker();
tracker.onChange(() => refreshTrackerUI());
const video = $('#video');
let stream = null, running = false, lastVideoTime = -1;
const driver = new FaceDriver();
if (state.baseline) { driver.bsBase = { ...state.baseline.bs }; driver.geoBase = state.baseline.geo ? { ...state.baseline.geo } : null; driver.locked = true; }
const stats = { fps: 0, tFps: 0, n: 0, tn: 0, t0: performance.now(), face: false, pose: false };

// after the avatar is up: download the tracking models in the background and get the face tracker
// ready, so Start is (nearly) instant. Downloads are kept on the device (tracker.js).
let warmed = false;
function warmUp() {
  if (warmed || TEST) return; warmed = true;
  const needs = { needPose: state.mode !== 'face', needHands: state.mode !== 'face' && state.body.hands, poseModel: state.poseModel };
  setTimeout(() => {
    tracker.prefetch(needs);
    const go = () => { if (!running) tracker.init({ ...needs, delegate: state.delegate }).then(() => mark('trackerWarm')).catch((e) => console.warn('warm-up', e)); };
    (window.requestIdleCallback || ((f) => setTimeout(f, 300)))(go, { timeout: 2500 });
  }, 400);
}
async function startCamera() {
  if (!avatar.vrm) { toast('Load the Mr. Puzzles .vrm first'); return; }
  try {
    status('Starting camera…');
    stream?.getTracks().forEach((t) => t.stop());
    // camera permission and face tracking at the same time; body / hands follow in the background
    const models = ensureEssential();
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: state.facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } });
    video.srcObject = stream; await video.play();
    const { face } = await models;
    mark('cameraReady');
    perf.hold(5000);
    if (!face.ok) toast('Face tracking could not start. ⚙︎ → Speed → Retry, or reload.', 6000);
    running = true; $('#btn-cam').classList.add('on'); $('#btn-cam').textContent = 'Stop'; syncUI();
    if (!state.baseline) { driver.reset(); setTimeout(() => running && !state.baseline && startCalibration(), 900); }
    status('');
  } catch (e) { console.error(e); status(''); toast('Camera: ' + e.message); }
}
function stopCamera() { running = false; stream?.getTracks().forEach((t) => t.stop()); stream = null; $('#btn-cam').classList.remove('on'); $('#btn-cam').textContent = 'Start'; syncUI(); }
/** make sure the trackers for the current mode exist (waits for all of them: used by tests and retry) */
async function ensureModels() {
  // quiet: progress shows in the tracker chip, not over the avatar
  return tracker.init({ needPose: state.mode !== 'face', needHands: state.mode !== 'face' && state.body.hands, poseModel: state.poseModel, delegate: state.delegate });
}
/** essential first: resolves once FACE tracking is ready; body / hands keep starting in the background
 *  (the chip shows them) and join the moment they are ready */
async function ensureEssential() {
  const face = await tracker.init({ needPose: false, needHands: false, delegate: state.delegate, onStatus: status });
  const rest = state.mode !== 'face' ? ensureModels().then((r) => {
    if (r.failed.length) toast(`${r.failed.map((k) => TNAME[k]).join(' and ')} tracking could not start; the rest works. ⚙︎ → Speed → Retry.`, 6000);
    perf.hold(3000);
  }) : Promise.resolve();
  return { face, rest };
}

let lastT = performance.now();
/** one tracking step on an image source (video element / canvas); exported for tests */
function processFrame(src, nowMs, dt) {
  const w = src.videoWidth || src.width, h = src.height && !src.videoHeight ? src.height : src.videoHeight;
  const size = { width: w, height: h };
  const body = state.mode !== 'face';
  // when the device struggles, body and hand detection take turns (face runs every frame); a skipped
  // detector's last result is reused for a short while so nothing looks "lost"
  frameNo++;
  const st = detectStride, poseDue = body && (st === 1 || frameNo % st === 0), handsDue = body && state.body.hands && (st === 1 || frameNo % st === 1 % st);
  const t0 = performance.now();
  const res = tracker.detect(src, nowMs, { pose: poseDue, hands: handsDue });
  const tNow = performance.now();
  if (poseDue) recent.pose = { r: res.pose, t: tNow }; else if (body && recent.pose && tNow - recent.pose.t < 250) res.pose = recent.pose.r;
  if (handsDue) recent.hands = { r: res.hands, t: tNow }; else if (body && state.body.hands && recent.hands && tNow - recent.hands.t < 250) res.hands = recent.hands.r;
  perf.tracked(tNow, tNow - t0);
  lastRes = res;
  const now = nowMs / 1000;
  // face ----------------------------------------------------------------
  const fl = res.face?.faceLandmarks?.[0];
  stats.face = !!fl; lastFrameAt = performance.now(); lostFor = fl ? 0 : lostFor + dt;
  if (fl) {
    const inp = driverInput(res.face, w / h);
    const r = driver.step(inp, dt, { tuning: state.tuning, mirror: state.mirror });
    if (r.calibrated) finishCalibration();
    avatar.setFace(r.weights, dt, r.mood, { responsiveness: state.tuning.responsiveness, conf: r.conf, pop: (STYLES[state.tuning.style] || STYLES.zamination).pop });
    lastFace = { bs: inp.bs, weights: r.weights, cues: r.cues, mood: r.mood, conf: r.conf };
    // (Kalidokit rescales the landmarks it gets in place: give it a copy, the overlay needs the originals)
    const fs = Kalidokit.Face.solve(fl.map((p) => ({ x: p.x, y: p.y, z: p.z })), { runtime: 'mediapipe', imageSize: size, smoothBlink: false });
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
let lastFace = null, lastRes = null, frameNo = 0, detectStride = 1;
const recent = { pose: null, hands: null };
// ---------------------------------------------------------------- camera preview + tracker overlay
const feed = $('#feed'), feedfx = $('#feedfx');
function drawPreview(res) {
  const m = state.preview.mode;
  if (m !== 'overlay' && m !== 'tracking') return;
  const w = video.videoWidth || 640, h = video.videoHeight || 480;
  if (feedfx.width !== w || feedfx.height !== h) { feedfx.width = w; feedfx.height = h; }
  const g = feedfx.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (m === 'tracking') { g.fillStyle = '#0b0812'; g.fillRect(0, 0, w, h); }
  if (res) drawTracking(g, res, { mirror: false, scale: state.preview.size === 'large' ? 1 : 1.6 });
  const nh = res?.hands?.landmarks?.length || 0;
  $('#feedtag').textContent = `face ${res?.face?.faceLandmarks?.length ? '✓' : '–'}` + (state.mode !== 'face' ? ` · body ${res?.pose?.landmarks?.length ? '✓' : '–'} · hands ${nh}` : '');
}
feed.addEventListener('click', () => { state.preview.size = state.preview.size === 'large' ? 'small' : 'large'; persist(); syncUI(); });
// ---------------------------------------------------------------- TV (stand-by card + glitches)
let lostFor = 99, lastFrameAt = -1e9;
const headQ = new THREE.Quaternion(), headQPrev = new THREE.Quaternion(); let headQValid = false;
function wantStandby() {
  if (!state.tv.standby || !avatar.vrm || avatar.posing) return false;
  const tracking = running || performance.now() - lastFrameAt < 1500;   // live camera or a test driving frames
  return tracking ? lostFor > 1.0 : !voice.on;                         // camera off: card, unless talking via the mic
}
function tvStep(dt) {
  if (!avatar.vrm || !avatar.screenFx) return;
  // how fast the head turns (rad/s): a hard shake makes the picture tear
  let speed = 0;
  avatar.vrm.humanoid.getBoneNode('head').getWorldQuaternion(headQ);
  if (headQValid && dt > 0) speed = 2 * Math.acos(Math.min(1, Math.abs(headQ.dot(headQPrev)))) / dt;
  headQPrev.copy(headQ); headQValid = true;
  const o = tv.update(dt, wantStandby(), lostFor > 0 ? 0 : speed, { glitches: state.tv.glitches, crt: state.tv.crt });
  if (state.tv.glitches) o.glitch = Math.max(o.glitch, poser.glitch);      // e.g. a jolt of static on Shock
  avatar.screenFx.setTv(o);
}

function loop() {
  requestAnimationFrame(loop);
  if (window.app && window.app.manual) return;     // automated tests drive frames themselves
  if (contextLost) return;
  const t = performance.now(), dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
  perf.frame(t);
  if (t - lastHousekeeping > 1000) { lastHousekeeping = t; housekeeping(t); }
  if (running && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try { processFrame(video, t, dt); drawPreview(lastRes); stats.tn++; } catch (e) { console.error(e); }
  } else if (!running && rig) {
    avatar.setFace(null, dt); rig.applyBody(null, null, { now: t / 1000, dt });
  }
  if (voice.on || voice.env > 0.001) { const lv = voice.update(dt); $('#btn-mic').style.setProperty('--lvl', (lv * 100).toFixed(0) + '%'); }
  avatar.update(dt);
  tvStep(dt);
  frameCamera(dt);
  if (look) look.render(camera); else renderer.render(scene, camera);
  if (avatar.vrm) { mark('firstFrame'); bootDone(); }
  stats.n++;
  if (t - stats.t0 > 1000) {
    stats.fps = stats.n * 1000 / (t - stats.t0); stats.tFps = stats.tn * 1000 / (t - stats.t0); stats.n = stats.tn = 0; stats.t0 = t;
    $('#hud').textContent = running ? `${stats.fps.toFixed(0)} fps · tracking ${stats.tFps.toFixed(0)}/s · ${stats.face ? 'face ✓' : 'face –'}${state.mode !== 'face' ? (stats.pose ? ' · body ✓' : ' · body –') : ''}` : '';
  }
}

// ---------------------------------------------------------------- performance
const perf = new PerfManager();
let lastHousekeeping = 0, contextLost = false;
/** apply the performance plan: quality = the user's choice, capped while the device struggles */
function applyPerf() {
  if (!look) return;
  const plan = perf.plan(state.perf.auto, { tracking: running, quality: state.look });
  if (look.mode !== plan.quality) look.set(plan.quality);
  if (look.pixelCap !== plan.pixelCap) { look.pixelCap = plan.pixelCap; look.applyPixelRatio(); resize(); }
  detectStride = plan.stride;
  perfPlan = plan;
}
let perfPlan = { state: 'healthy', quality: state.look, pixelCap: null, stride: 1 };
function housekeeping(t) {
  if (perf.update(t, { tracking: running })) {
    applyPerf();
    if (perf.state !== 'healthy' && state.perf.auto) toast(perf.state === 'critical' ? 'Your device is struggling: lowered the quality to keep tracking smooth' : 'Lowered the quality a little to keep things smooth', 3500);
    if (perf.state === 'critical') releaseUnused(0);
  }
  // optional trackers not used for 3 minutes give their memory back (their models stay downloaded)
  releaseUnused(180000);
  // shaders of the other quality modes are compiled while nothing else is going on
  if (!prepQueue.length || !avatar.vrm || !look || perf.state !== 'healthy') return;
  // not while the trackers are being set up (both need the GPU; tracking comes first)
  if (!timings.trackerWarm && !(timings.firstFrame && t - timings.firstFrame > 8000)) return;
  if (Object.values(tracker.status).some((st) => st.state === 'starting')) return;
  if (running && perf.fps < 45) return;
  const m = prepQueue.shift();
  const ts = performance.now();
  if (look.prepare(camera, m)) { timings['prepare_' + m] = Math.round(performance.now() - ts); perf.hold(1500); }
}
let prepQueue = [];
function releaseUnused(idleMs) {
  const needPose = running && state.mode !== 'face', needHands = needPose && state.body.hands;
  for (const k of ['pose', 'hand']) {
    if ((k === 'pose' ? needPose : needHands) || !tracker[k]) continue;
    if (performance.now() - tracker.status[k].lastUsed > idleMs) tracker.release(k);
  }
}
// the GPU can drop the graphics context (memory pressure, backgrounding on iOS): pause, then rebuild
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); contextLost = true; status('Graphics restarting…'); });
canvas.addEventListener('webglcontextrestored', () => {
  contextLost = false; status('');
  if (look) { look.resetPrepared?.(); look.set(look.mode); prepQueue = ['low', 'medium', 'high'].filter((m) => m !== look.mode); }
  perf.hold(5000);
  toast('Graphics restored');
});

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
  // mic on: the recording gets its audio (Mic button)
  if (voice.on && voice.track()) s.addTrack(voice.track());
  const type = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!type) { toast('Recording not supported in this browser'); return; }
  rec = new MediaRecorder(s, { mimeType: type, videoBitsPerSecond: 6e6, audioBitsPerSecond: 128e3 }); chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    const blob = new Blob(chunks, { type }); rec = null; $('#btn-rec').classList.remove('on');
    shareOrDownload(blob, `mr-puzzles-${Date.now()}.${type.includes('mp4') ? 'mp4' : 'webm'}`);
  };
  rec.start(); $('#btn-rec').classList.add('on');
}

/** Share sheet on phones (Save Video / Save Image), download elsewhere */
async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// ---------------------------------------------------------------- photo
/** PNG of the avatar (keeps the transparency on a transparent background). Synchronous on purpose:
 *  iOS only opens the Share sheet straight from the tap. */
function takePhoto() {
  if (!avatar.vrm) return null;
  if (look) look.render(camera); else renderer.render(scene, camera);
  const url = canvas.toDataURL('image/png');
  const bin = atob(url.split(',')[1]), buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const blob = new Blob([buf], { type: 'image/png' });
  const f = $('#flash'); f.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
  return blob;
}

// ---------------------------------------------------------------- streaming: background + clean view
const CHROMA = ['#00b140', '#0047bb', 'transparent'];
function applyBackground() {
  const transparent = state.bg === 'transparent';
  scene.background = transparent ? null : new THREE.Color(state.bg);
  document.documentElement.classList.toggle('transparent', transparent);
  look?.setFloor(!CHROMA.includes(state.bg));
}
function setClean(on) {
  document.documentElement.classList.toggle('clean', on);
  if (on) toast('Clean view: double-tap the screen or press H to show the buttons', 3000);
}
const isClean = () => document.documentElement.classList.contains('clean');
// double-tap / double-click anywhere on the avatar brings the controls back (works with touch and mouse)
let lastTap = { t: 0, x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => {
  const now = performance.now();
  if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) { if (isClean()) setClean(false); lastTap.t = 0; return; }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  if (e.key === 'h' || e.key === 'H') setClean(!isClean());
  else if (e.key === 'Escape' && isClean()) setClean(false);
});
if (params.has('clean')) setClean(true);

// ---------------------------------------------------------------- UI
function status(s) { $('#status').textContent = s; $('#status').hidden = !s; }
let toastT; function toast(s, ms = 3500) { const el = $('#toast'); el.textContent = s; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), ms); }
function syncUI() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  const pm = state.preview.mode;
  feed.hidden = pm === 'off' || !running;
  feed.classList.toggle('mirror', state.facing === 'user');
  feed.classList.toggle('tracking', pm === 'tracking');
  feed.classList.toggle('large', state.preview.size === 'large');
  feedfx.hidden = pm === 'camera'; $('#feedtag').hidden = pm === 'camera';
  if (pm === 'camera') $('#feedtag').textContent = '';
  applyBackground();
  $('#poses').hidden = !state.poseButtons;
  if (rig) Object.assign(rig.opts, state.body);
  avatar.voiceStrength = state.voiceStrength;
  settingsUI?.refresh();
  refreshTrackerUI();
}
async function setMode(m) {
  state.mode = m; persist(); syncUI(); perf.hold(4000);
  if (state.mode === 'full') toast('Full body: put the phone ~2.5–3 m away so your whole body (head to feet) is in view.', 5000);
  if (running) ensureModels().then((r) => { if (r.failed.length) toast(`${r.failed.map((k) => TNAME[k]).join(' and ')} tracking could not start. ⚙︎ → Speed → Retry.`, 6000); });
  else tracker.prefetch({ needPose: m !== 'face', needHands: m !== 'face' && state.body.hands, poseModel: state.poseModel });
}
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---------------------------------------------------------------- diagnostics (only real measurements)
let gpuName = null;
function diagnosticsHTML() {
  if (gpuName === null) { try { const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); gpuName = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch { gpuName = ''; } }
  const ST = { healthy: ['Healthy', 'ok'], struggling: ['Struggling: lowered a little', 'warn'], critical: ['Critical: lowered a lot', 'bad'] };
  const [sl, sc] = ST[state.perf.auto ? perf.state : 'healthy'];
  const q = (m) => m[0].toUpperCase() + m.slice(1);
  const ms = (k) => (tracker[k] ? Math.round(tracker.inferMs[k]) + ' ms' : '–');
  const row = (k, v, c = '') => `<tr><td class="k">${k}</td><td class="${c}">${v}</td></tr>`;
  const tr = ['face', 'pose', 'hand'].map((k) => { const st = tracker.status[k], [t, c] = trackerText(k); return row(TNAME[k] + ' tracking', t + (st.state === 'ready' && st.ms != null ? ` (${(st.ms / 1000).toFixed(1)} s)` : '') + (st.state === 'failed' && st.error ? `<br><small>${st.error.slice(0, 80)}</small>` : ''), c === 'ready' ? 'ok' : c === 'failed' ? 'bad' : ''); }).join('');
  const info = renderer.info;
  return `<table>
    ${row('State', state.perf.auto ? sl : 'Automatic off', state.perf.auto ? sc : '')}
    ${row('Drawing', Math.round(perf.fps) + ' fps')}
    ${row('Tracking', running ? `${Math.round(perf.trackFps)}/s · ${Math.round(perf.trackMs)} ms per frame` : 'camera off')}
    ${running ? row('Per tracker', `face ${ms('face')} · body ${state.mode !== 'face' ? ms('pose') : '–'} · hands ${state.mode !== 'face' && state.body.hands ? ms('hand') : '–'}`) : ''}
    ${row('Quality in use', q(look ? look.mode : state.look) + (look && look.mode !== state.look ? ` (you chose ${q(state.look)})` : '') + ` · ${renderer.getPixelRatio().toFixed(2)}× resolution`)}
    ${detectStride > 1 && running && state.mode !== 'face' ? row('Body / hands', `every ${detectStride} frames (taking turns)`, 'warn') : ''}
    ${tr}
    ${row('Avatar ready after', timings.firstFrame ? (timings.firstFrame / 1000).toFixed(1) + ' s' : '…')}
    ${row('Graphics', `${info.programs?.length ?? 0} shaders · ${info.memory.textures} textures · ${info.memory.geometries} meshes`)}
    ${gpuName ? row('GPU', gpuName.slice(0, 60)) : ''}
  </table>`;
}

// ---------------------------------------------------------------- settings panel
const T = state.tuning, pct = (v) => Math.round(v * 100) + '%', x = (v) => '×' + v.toFixed(2);
const set = (fn) => (v) => { fn(v); persist(); syncUI(); };
const TABS = [
  { id: 'face', icon: '🙂', label: 'Face' }, { id: 'body', icon: '🙌', label: 'Body' }, { id: 'cam', icon: '📷', label: 'Camera' },
  { id: 'screen', icon: '📺', label: 'Screen' }, { id: 'sound', icon: '🎙️', label: 'Sound' }, { id: 'look', icon: '🎨', label: 'Look' },
  { id: 'speed', icon: '⚡', label: 'Speed' }, { id: 'more', icon: '⋯', label: 'More' },
];
const ITEMS = [
  // face
  { tab: 'face', type: 'buttons', label: 'Neutral face', desc: 'Relax and look at the camera for a second. Redo it if expressions look off.', buttons: [['Calibrate', () => { $('#settings').hidden = true; startCalibration(); }, 'primary', 'btn-cal']] },
  { tab: 'face', card: 'Style', type: 'seg', id: 'o-style', label: 'Tracking style', options: [['zamination', 'ZAMination'], ['balanced', 'Balanced'], ['accurate', 'Accurate']], get: () => T.style, set: set((v) => (T.style = v)) },
  { tab: 'face', card: 'Style', type: 'note', desc: 'ZAMination: dramatic cartoon poses. Accurate: follows your face closely.' },
  { tab: 'face', card: 'Exaggeration', type: 'slider', id: 't-intensity', label: 'Overall', min: 0.3, max: 2, fmt: x, reset: 1, get: () => T.intensity, set: set((v) => (T.intensity = v)) },
  { tab: 'face', card: 'Exaggeration', type: 'slider', id: 't-eyeIntensity', label: 'Eyes', min: 0.3, max: 2, fmt: x, reset: 1, get: () => T.eyeIntensity, set: set((v) => (T.eyeIntensity = v)) },
  { tab: 'face', card: 'Exaggeration', type: 'slider', id: 't-browIntensity', label: 'Eyebrows', min: 0.3, max: 2.5, fmt: x, reset: 1, get: () => T.browIntensity, set: set((v) => (T.browIntensity = v)) },
  { tab: 'face', card: 'Exaggeration', type: 'slider', id: 't-mouthIntensity', label: 'Mouth', min: 0.3, max: 2, fmt: x, reset: 1, get: () => T.mouthIntensity, set: set((v) => (T.mouthIntensity = v)) },
  { tab: 'face', card: 'Exaggeration', type: 'slider', id: 't-gaze', label: 'Pupil movement', min: 0, max: 2.5, fmt: x, reset: 1, get: () => T.gaze, set: set((v) => (T.gaze = v)) },
  { tab: 'face', card: 'Exaggeration', type: 'slider', id: 't-responsiveness', label: 'Smooth ↔ snappy', min: 0.4, max: 2.5, fmt: x, reset: 1, get: () => T.responsiveness, set: set((v) => (T.responsiveness = v)) },
  { tab: 'face', card: 'Options', type: 'switch', id: 'o-glasses', label: 'I wear glasses', desc: 'Steadier eyes behind lenses; blinks need a clearer close.', get: () => T.glasses, set: set((v) => (T.glasses = v)) },
  { tab: 'face', card: 'Options', type: 'switch', id: 'o-mirror', label: 'Mirror the face', desc: 'On: like a mirror (wink your left eye, his eye on your left winks).', get: () => state.mirror, set: set((v) => (state.mirror = v)) },
  { tab: 'face', card: 'Options', type: 'switch', id: 'o-poses', label: 'Expression buttons', desc: 'Rage, Shock, Stare, Smug, Joy, Worry above the bar. Tap or hold; keys 1–6.', get: () => state.poseButtons, set: set((v) => (state.poseButtons = v)) },
  // body
  { tab: 'body', card: 'Tracking', type: 'seg', id: 'o-mode', label: 'Track', options: [['face', 'Face'], ['upper', 'Upper body'], ['full', 'Full body']], get: () => state.mode, set: (v) => setMode(v) },
  { tab: 'body', card: 'Tracking', type: 'switch', id: 'o-hands', label: 'Hands & fingers', desc: 'Thumbs up, peace, pointing… Turn off to save battery.', get: () => state.body.hands, set: async (v) => { state.body.hands = v; persist(); syncUI(); if (running && v) ensureModels(); } },
  { tab: 'body', card: 'Arms', type: 'seg', id: 'o-solver', label: 'Arm solver', options: [['aim', '3D (new)'], ['classic', 'Classic']], get: () => state.body.solver, set: set((v) => (state.body.solver = v)) },
  { tab: 'body', card: 'Arms', type: 'note', desc: '3D aims every bone along your real arm in 3D: crossed arms, pointing at the camera and gestures come out right.', show: () => state.body.solver === 'aim' },
  { tab: 'body', card: 'Arms', type: 'switch', id: 'o-lift', label: 'Depth from arm length', desc: 'Works out how far your arm reaches toward the camera from how short it looks.', get: () => state.body.lift, set: set((v) => (state.body.lift = v)), show: () => state.body.solver === 'aim' },
  { tab: 'body', card: 'Arms', type: 'slider', id: 't-follow', label: 'Smooth ↔ snappy', min: 0, max: 1, step: 0.05, fmt: pct, reset: 0.75, get: () => state.body.follow, set: set((v) => (state.body.follow = v)), show: () => state.body.solver === 'aim' },
  { tab: 'body', card: 'Body model', type: 'seg', id: 'o-pose', label: 'Body model', desc: 'Full is more accurate, Lite is faster.', options: [['lite', 'Lite'], ['full', 'Full']], get: () => state.poseModel, set: (v) => { state.poseModel = v; persist(); if (running) ensureModels(); } },
  // camera
  { tab: 'cam', card: 'Camera', type: 'seg', id: 'o-facing', label: 'Camera', options: [['user', 'Front'], ['environment', 'Back']], get: () => state.facing, set: async (v) => { state.facing = v; persist(); syncUI(); if (running) await startCamera(); } },
  { tab: 'cam', card: 'Preview', type: 'seg', id: 'o-preview', label: 'Show', options: [['off', 'Off'], ['camera', 'Camera'], ['overlay', 'Camera + tracking'], ['tracking', 'Tracking']], get: () => state.preview.mode, set: set((v) => (state.preview.mode = v)) },
  { tab: 'cam', card: 'Preview', type: 'note', desc: '“Camera + tracking” draws what the tracker sees: face outline, body skeleton (pink = your left, blue = your right, faint = guessed) and hands.' },
  { tab: 'cam', card: 'Preview', type: 'seg', id: 'o-psize', label: 'Size', desc: 'Or tap the preview.', options: [['small', 'Small'], ['large', 'Large']], get: () => state.preview.size, set: set((v) => (state.preview.size = v)), show: () => state.preview.mode !== 'off' },
  { tab: 'cam', card: 'Performance', type: 'seg', id: 'o-delegate', label: 'Processor', desc: 'GPU is faster; use CPU if tracking misbehaves. Reload to apply.', options: [['GPU', 'GPU'], ['CPU', 'CPU']], get: () => state.delegate, set: (v) => { state.delegate = v; persist(); toast('Reload the page to apply'); } },
  // screen
  { tab: 'screen', card: 'TV', type: 'switch', id: 'o-standby', label: '“Please Stand By”', desc: 'Test card on the screen when no face is found.', get: () => state.tv.standby, set: set((v) => (state.tv.standby = v)) },
  { tab: 'screen', card: 'TV', type: 'switch', id: 'o-glitch', label: 'TV glitches', desc: 'Static when you shake your head hard.', get: () => state.tv.glitches, set: set((v) => (state.tv.glitches = v)) },
  { tab: 'screen', card: 'TV', type: 'switch', id: 'o-crt', label: 'Old-TV scanlines', get: () => state.tv.crt, set: set((v) => (state.tv.crt = v)) },
  { tab: 'screen', card: 'Mood', type: 'switch', id: 'o-mood', label: 'Red flash', desc: 'On sudden anger or shouting.', get: () => T.autoMoodColor, set: set((v) => (T.autoMoodColor = v)) },
  { tab: 'screen', card: 'Mood', type: 'switch', id: 'o-green', label: 'Green when disgusted', get: () => T.greenFx, set: set((v) => (T.greenFx = v)) },
  { tab: 'screen', card: 'Mood', type: 'slider', id: 't-shading', label: 'Eyelid / brow shading', min: 0, max: 1.5, fmt: pct, reset: 1, get: () => T.shading, set: set((v) => (T.shading = v)) },
  { tab: 'screen', card: 'Mood', type: 'seg', id: 'o-tint', label: 'Screen colour', desc: 'Force a colour (not saved).', options: [['auto', 'Auto'], ['red', 'Red'], ['green', 'Green']], get: () => (avatar.manualTint ? (avatar.manualTint.red ? 'red' : 'green') : 'auto'), set: (v) => { avatar.manualTint = v === 'auto' ? null : { red: v === 'red' ? 1 : 0, green: v === 'green' ? 1 : 0 }; } },
  // sound
  { tab: 'sound', card: 'Microphone', type: 'note', desc: 'Tap 🎙 Mic in the bar: recordings get your voice and the mouth reacts to it.' },
  { tab: 'sound', card: 'Microphone', type: 'slider', id: 't-voice', label: 'Mouth follows voice', min: 0, max: 1.5, fmt: pct, reset: 1, get: () => state.voiceStrength, set: set((v) => (state.voiceStrength = v)) },
  { tab: 'sound', card: 'Microphone', type: 'switch', id: 'o-tvvoice', label: 'TV speaker voice', desc: 'Recordings sound like they come out of an old TV.', get: () => state.tvVoice, set: set((v) => { state.tvVoice = v; voice.setTvVoice(v); }) },
  // look
  { tab: 'look', card: 'Quality', type: 'seg', id: 'o-look', label: 'Quality', desc: 'Low: flat, fastest · Medium: lit · High: rendered look.', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], get: () => state.look, set: (v) => { state.look = v; persist(); perf.hold(3000); applyPerf(); resize(); } },
  { tab: 'look', card: 'Background', type: 'swatch', id: 'o-bg', label: 'Background', options: [['#2b2140', 'PuzzleVision purple'], ['#0d0912', 'Studio dark'], ['#111111', 'Black'], ['#f2f0f5', 'White'], ['#00b140', 'Green screen'], ['#0047bb', 'Blue screen'], ['transparent', 'Transparent (OBS browser source)']], get: () => state.bg, set: set((v) => (state.bg = v)) },
  { tab: 'look', card: 'Streaming', type: 'buttons', label: 'Clean view', desc: 'Hide all buttons. Double-tap or press H to bring them back.', buttons: [['Hide buttons', () => { $('#settings').hidden = true; setClean(true); }, '', 'o-clean']] },
  { tab: 'look', card: 'Streaming', type: 'note', desc: 'OBS: pick Green screen and add a Window Capture of this browser with a Chroma Key filter. Or pick Transparent and add this page as a Browser Source (start OBS with --enable-media-stream so it may use the camera).' },
  // speed
  { tab: 'speed', card: 'Performance', type: 'switch', id: 'o-autoperf', label: 'Automatic performance', desc: 'If your device keeps struggling, lower the resolution and quality for a while and let body / hand tracking take turns. Face tracking is never reduced. Your own quality choice comes back when things are smooth again.', get: () => state.perf.auto, set: set((v) => { state.perf.auto = v; applyPerf(); }) },
  { tab: 'speed', card: 'Right now', type: 'live', html: diagnosticsHTML },
  { tab: 'speed', card: 'Recovery', type: 'buttons', label: 'If something is stuck', desc: 'Retry trackers that failed to start, free the memory of body / hand tracking you are not using, or reload.', buttons: [
    ['Retry trackers', async () => { status('Retrying…'); const r = await tracker.init({ needPose: state.mode !== 'face', needHands: state.mode !== 'face' && state.body.hands, poseModel: state.poseModel, delegate: state.delegate, onStatus: status, retryFailed: true }); status(''); toast(r.failed.length ? 'Still failing: ' + r.failed.map((k) => TNAME[k]).join(', ') : 'All trackers ready'); }, '', 'o-retry'],
    ['Free memory', () => { releaseUnused(0); toast('Released the trackers not in use'); }, '', 'o-free'],
    ['Reload app', () => location.reload(), '', 'o-reload']] },
  { tab: 'speed', card: 'Downloads', type: 'buttons', label: 'Downloaded tracking models', desc: 'Kept on this device so Start is quick. Clearing frees storage; they download again when needed.', buttons: [
    ['Clear downloads', async () => { try { await caches.delete(MODEL_CACHE); toast('Cleared. They download again when needed.'); } catch { toast('Could not clear'); } }, 'danger', 'o-clearcache']] },
  // more
  { tab: 'more', card: 'Avatar', type: 'buttons', label: 'Model', desc: 'Mr. Puzzles is built in. You can load another VRM avatar.', buttons: [['Use my own .vrm…', () => $('#file').click(), '', 'btn-load'], ['Built-in Mr. Puzzles', async () => { await clearModel(); location.reload(); }, '', 'btn-builtin']] },
  { tab: 'more', card: 'Reset', type: 'buttons', label: 'Start over', desc: 'Forget the calibration, or put every setting back to default.', buttons: [
    ['Reset calibration', () => { state.baseline = null; driver.reset(); persist(); toast('Calibration cleared: tap Calibrate with a relaxed face'); }, '', 'o-reset-cal'],
    ['Reset everything', () => { if (!confirm('Put all settings back to default?')) return; try { localStorage.removeItem('mp-settings'); } catch {} location.reload(); }, 'danger', 'o-reset']] },
  { tab: 'more', card: 'About', type: 'note', desc: 'PuzzleVision Cam. Model & rig: “Zamination Style Mr Puzzles” fan model by BonBon (bonbon099.gumroad.com). Mr. Puzzles © SMG4. Unofficial, non-commercial fan project. Tracking: MediaPipe. Rendering: three.js + three-vrm.' },
];
const settingsUI = buildSettings($('#settings'), TABS, ITEMS);
setInterval(() => { if (!$('#settings').hidden) settingsUI.refresh(); }, 1000);
settingsUI.close.addEventListener('click', () => ($('#settings').hidden = true));
$('#btn-cam').addEventListener('click', () => (running ? stopCamera() : startCamera()));
$('#btn-rec').addEventListener('click', toggleRecord);
$('#btn-mic').addEventListener('click', async () => {
  const b = $('#btn-mic');
  if (voice.on) { voice.stop(); b.classList.remove('on'); b.style.setProperty('--lvl', '0%'); if (rec) toast('Mic off (recording continues silently)'); return; }
  try {
    await voice.start(); b.classList.add('on');
    toast(rec ? 'Mic on: the mouth follows your voice (audio starts with the next recording)' : 'Mic on: the mouth follows your voice, recordings include audio');
  } catch (e) { console.error(e); toast('Microphone not available (permission denied?)'); }
});
$('#btn-photo').addEventListener('click', () => { const b = takePhoto(); if (b) shareOrDownload(b, `mr-puzzles-${Date.now()}.png`); });
$('#btn-set').addEventListener('click', () => ($('#settings').hidden = !$('#settings').hidden));
$('#empty-load').addEventListener('click', () => $('#file').click());
// expression buttons: tap = play, hold = keep; keys 1-6 the same
{
  const row = $('#poses');
  for (const p of POSES) {
    const b = document.createElement('button'); b.dataset.pose = p.id; b.title = p.label + ' (tap, or hold)';
    b.innerHTML = `<span class="i">${p.icon}</span><span>${p.label}</span>`;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); poser.press(p.id); b.classList.add('on'); });
    const up = () => { if (!b.classList.contains('on')) return; poser.release(); b.classList.remove('on'); };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    row.appendChild(b);
  }
  document.addEventListener('keydown', (e) => {
    if (e.repeat || (e.target.closest && e.target.closest('input, select, textarea'))) return;
    const p = POSES[+e.key - 1]; if (p) poser.press(p.id);
  });
  document.addEventListener('keyup', (e) => { if (POSES[+e.key - 1]) poser.release(); });
}
document.addEventListener('visibilitychange', () => { if (document.hidden && running) stopCamera(); });

syncUI(); resize(); bootModel(); loop();

// test / automation hooks --------------------------------------------------------------
window.app = {
  state, avatar, tracker, driver, ensureModels, useModel, processFrame, frameCamera, renderer, scene,
  get rig() { return rig; },
  get look() { return look; },
  render(dt = 1 / 30) { avatar.update(dt); tvStep(dt); frameCamera(dt, true); if (look) look.render(camera); else renderer.render(scene, camera); bootDone(); },
  setMode(m) { state.mode = m; syncUI(); }, settingsUI, drawPreview, timings, perf, applyPerf, get perfPlan() { return perfPlan; }, prepare: () => { while (prepQueue.length) { const m = prepQueue.shift(); const t = performance.now(); look.prepare(camera, m); timings['prepare_' + m] = Math.round(performance.now() - t); } }, warmUp: () => { warmed = false; warmUp(); },
  tv, get lostFor() { return lostFor; }, takePhoto, setClean, poser, voice, drawTracking, get camera() { return camera; },
  /** test: render the hand of the avatar side s up close */
  renderHand(s) { const h = avatar.vrm.humanoid.getBoneNode(s + 'Hand').getWorldPosition(new THREE.Vector3()); const m = avatar.vrm.humanoid.getBoneNode(s + 'MiddleProximal').getWorldPosition(new THREE.Vector3()); const c = h.clone().lerp(m, 0.6); camera.position.set(c.x, c.y + 0.05, c.z + 0.55); camera.lookAt(c); if (look) look.render(camera); else renderer.render(scene, camera); },
  simulateFace(found, dt = 1 / 30) { lastFrameAt = performance.now(); lostFor = found ? 0 : lostFor + dt; },
};
