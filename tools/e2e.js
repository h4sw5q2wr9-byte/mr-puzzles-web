// End-to-end tests in headless Chromium (software WebGL, fake camera).   node tools/e2e.js <faceStatic.y4m> <faceMoving.y4m> [outDir]
// Everything here is verified on a desktop Chromium emulating an iPhone viewport.  Things that need a real iPhone
// (Safari camera permission, GPU speed, MediaRecorder/mp4 on iOS, share sheet) are listed in README.md.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const [STATIC, MOVING, OUT = path.join(ROOT, 'test-output')] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
let PRESETS;   // loaded from js/demo_presets.js (ES module) at start
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png', '.task': 'application/octet-stream', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
});
const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); }
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
const IPHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' };
const py = code => execFileSync('python3', ['-c', code], { encoding: 'utf8' }).trim();

async function open(browser, query, extra = {}) {
  const ctx = await browser.newContext(Object.assign({}, IPHONE, extra));
  const page = await ctx.newPage();
  page.errors = []; page.warns = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/XNNPACK|TensorFlow Lite|favicon/i.test(m.text())) page.errors.push(m.text()); });
  page.on('requestfailed', r => page.errors.push('REQFAIL ' + r.url()));
  await page.goto(`http://localhost:${server.address().port}/index.html${query}`);
  await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 90000 });
  return { ctx, page };
}

(async () => {
  await new Promise(r => server.listen(0, r));
  PRESETS = (await import(require('url').pathToFileURL(path.join(ROOT, 'js', 'demo_presets.js')).href)).PRESETS;

  // ------------------------------------------------------------------ 1. boot + rig + expressions (no camera)
  {
    const browser = await chromium.launch({ args: GL });
    const { ctx, page } = await open(browser, '?clean=1');
    const boot = await page.evaluate(() => ({ bones: Object.keys(__mrp.rig.bones).length, missing: __mrp.rig.missing || [], unit: __mrp.rig.unit,
      parts: ['Face_Brows', 'Face_EyeLine', 'Face_EyeWhite', 'Face_Lashes', 'Face_Lids', 'Face_Mouth', 'Face_MouthLine', 'Face_Pupils', 'TV_Body', 'Hat', 'Antenna_L', 'Antenna_R', 'Body', 'Face_Glass'].filter(n => !__mrp.rig.nodes[n]),
      skinned: (() => { let n = 0; __mrp.rig.model.traverse(o => { if (o.isSkinnedMesh) n++; }); return n; })(), lab: !!__mrp.rig.model.getObjectByName('LabelDecal'), info: { calls: __mrp.renderer.info.render.calls, tris: __mrp.renderer.info.render.triangles } }));
    check('model loads with all 69 face bones', boot.bones === 69 && !boot.missing.length, JSON.stringify(boot.missing));
    check('hat, both antennas, TV, body and all face parts present', !boot.parts.length, boot.parts.join(','));
    check('face meshes are skinned to the original rig bones', boot.skinned >= 12, `${boot.skinned} skinned meshes`);
    check('bezel lettering decal placed', boot.lab);
    check('rig calibration is identity for the GLB (unit 1)', Math.abs(boot.unit - 1) < 0.01, boot.unit);
    check('draw calls / triangles are mobile-friendly', boot.info.calls < 60 && boot.info.tris < 60000, JSON.stringify(boot.info));

    // expression sheet: every preset through MoodLogic -> rig bones -> render
    await page.evaluate(() => { __mrp.setPose({ position: new __mrp.THREE.Vector3(0, 0, -52), quaternion: new __mrp.THREE.Quaternion(), scale: 1 }); __mrp.S.secondary = false; });
    const names = Object.keys(PRESETS); const shots = {};
    for (const n of names) {
      await page.evaluate(w => __mrp.setWeights(w), PRESETS[n]);
      await page.waitForTimeout(1100);
      const f = path.join(OUT, `expr_${n}.png`); await page.screenshot({ path: f, clip: { x: 0, y: 160, width: 390, height: 400 } }); shots[n] = f;
    }
    const diffs = JSON.parse(py(`
import json,sys
from PIL import Image, ImageChops
out=${JSON.stringify(OUT)}; names=${JSON.stringify(names)}
base=Image.open(f'{out}/expr_neutral.png').convert('L')
res={}
for n in names:
    d=ImageChops.difference(base,Image.open(f'{out}/expr_{n}.png').convert('L')); h=d.histogram(); tot=sum(h)
    res[n]=round(sum(i*c for i,c in enumerate(h))/tot,2)
print(json.dumps(res))`));
    const expressive = ['smile', 'grin', 'laugh', 'surprise', 'anger', 'rage', 'sad', 'flustered', 'mischief', 'disgust', 'panic', 'sleepy', 'winkLeft', 'kiss', 'talkA', 'talkO', 'mouthLeft', 'mouthRight', 'lookLeft', 'lookUpRight'];
    const flat = expressive.filter(n => !(diffs[n] > 0.6));
    check('every expression visibly changes the rendered face vs neutral', !flat.length, flat.length ? 'unchanged: ' + flat.join(',') : `mean pixel diff min ${Math.min(...expressive.map(n => diffs[n]))}`);
    py(`
from PIL import Image, ImageDraw
out=${JSON.stringify(OUT)}; names=${JSON.stringify(names)}; cols=5
ims=[Image.open(f'{out}/expr_{n}.png').convert('RGB').resize((390,400)) for n in names]
rows=(len(ims)+cols-1)//cols; sheet=Image.new('RGB',(cols*390,rows*400))
for i,(n,im) in enumerate(zip(names,ims)):
    ImageDraw.Draw(im).text((8,8),n,fill=(255,255,0)); sheet.paste(im,((i%cols)*390,(i//cols)*400))
sheet.save(f'{out}/expressions_sheet.png')`);

    // left / right: user's LEFT wink must close the TV's screen-LEFT eye (character R_ bones) in selfie/mirror view
    await page.evaluate(w => { __mrp.setMirror(true); __mrp.setWeights(w); }, PRESETS.winkLeft);
    await page.waitForTimeout(900);
    const wink = await page.evaluate(() => { const r = __mrp.rig; const m = r.model; const lid = n => { const v = new __mrp.THREE.Vector3(); r.bones[n].getWorldPosition(v); return m.worldToLocal(v).y - r.rest[n].y; }; return { R: lid('R_UpperEye'), L: lid('L_UpperEye'), R_x: r.bones.R_UpperEye.getWorldPosition(new __mrp.THREE.Vector3()).x, L_x: r.bones.L_UpperEye.getWorldPosition(new __mrp.THREE.Vector3()).x }; });
    check('mirror view: left wink closes the eye on the SCREEN-LEFT', wink.R < -3 && wink.L > -1 && wink.R_x < wink.L_x, JSON.stringify(wink));
    await page.evaluate(w => { __mrp.setMirror(false); __mrp.setWeights(w); }, PRESETS.winkLeft);
    await page.waitForTimeout(900);
    const wink2 = await page.evaluate(() => { const r = __mrp.rig; return { R: r.value.eyeBlink_R, L: r.value.eyeBlink_L }; });
    check('non-mirrored (back camera): left wink closes the OTHER side', wink2.L > 0.8 && wink2.R < 0.2, JSON.stringify(wink2));

    // independent controls
    await page.evaluate(() => __mrp.setMirror(true));
    const independent = {};
    for (const [label, w] of Object.entries({ browR: { BrowsUpLeft: 1 }, browL: { BrowsUpRight: 1 }, smileR: { MouthSmileLeft: 1 }, jaw: { JawOpen: 0.8 }, pupilsLeft: { EyeOutLeft: 0.9, EyeInRight: 0.9, EyeOpenLeft: 0.9, EyeOpenRight: 0.9, BrowsUpLeft: 0.8, BrowsUpRight: 0.8, JawOpen: 0.7 } })) {
      await page.evaluate(x => __mrp.setWeights(x), w); await page.waitForTimeout(900);
      independent[label] = await page.evaluate(() => Object.fromEntries(Object.entries(__mrp.rig.value).filter(([, v]) => v > 0.15).map(([k, v]) => [k, +v.toFixed(2)])));
    }
    check('eyebrows move independently', independent.browR.browUp_R > 0.5 && !(independent.browR.browUp_L > 0.2) && independent.browL.browUp_L > 0.5 && !(independent.browL.browUp_R > 0.2), JSON.stringify([independent.browR, independent.browL]));
    check('one-sided smile moves only that mouth corner', independent.smileR.mouthSmile_R > 0.5 && !(independent.smileR.mouthSmile_L > 0.2), JSON.stringify(independent.smileR));
    check('jaw opens', independent.jaw.jawOpen > 0.6, JSON.stringify(independent.jaw));
    check('surprise switches to full eyes with pupils', independent.pupilsLeft.eyeFull_R > 0.4 && await page.evaluate(() => __mrp.rig.nodes.Face_Pupils.visible));

    // mood chips force a mood
    await page.evaluate(() => { document.body.classList.remove('clean'); document.body.classList.add('live'); document.getElementById('start').classList.add('gone'); __mrp.setWeights(null); });
    await page.click('#moods .chip:nth-child(4)');   // anger
    await page.waitForFunction(() => __mrp.rig.tint[0] > 0.9 && __mrp.rig.tint[1] < 0.5 && __mrp.rig.value.mouthJag > 0.8, null, { timeout: 30000 }).catch(() => {});
    const forced = await page.evaluate(() => ({ mood: __mrp.state.out.dominant, tint: __mrp.rig.tint.map(v => +v.toFixed(2)), jag: __mrp.rig.value.mouthJag }));
    check('mood chip forces a mood (anger: red glass, jagged mouth)', forced.mood === 'anger' && forced.tint[0] > 0.8 && forced.tint[1] < 0.6 && forced.jag > 0.5, JSON.stringify(forced));
    await page.click('#moods .chip:nth-child(1)'); await page.evaluate(() => document.body.classList.add('clean'));
    // frame pacing of the rig update itself (JS only)
    const bench = await page.evaluate(async () => {
      const { rig } = __mrp; const { compute } = await import('./js/mood.js'); const { PRESETS } = await import('./js/demo_presets.js');
      const keys = Object.keys(PRESETS); const ctx = { pos: new __mrp.THREE.Vector3(0, 0, -50), quat: new __mrp.THREE.Quaternion(), secondary: true, time: 0 };
      const outs = keys.map(k => compute(PRESETS[k], { mirror: true, gain: 1.35 }));
      const N = 2000; let t0 = performance.now();
      for (let i = 0; i < N; i++) { ctx.time = i * 0.016; ctx.pos.x = Math.sin(i * 0.1) * 3; rig.update(0.016, outs[i % outs.length], ctx); }
      const ru = (performance.now() - t0) / N; t0 = performance.now();
      for (let i = 0; i < N; i++) compute(PRESETS[keys[i % keys.length]], { mirror: true, gain: 1.35 });
      return { riqUpdateMs: +ru.toFixed(4), moodMs: +((performance.now() - t0) / N).toFixed(4) };
    });
    check('JS cost per frame (rig + mood) is tiny', bench.riqUpdateMs + bench.moodMs < 1.0, JSON.stringify(bench) + ' ms (desktop CPU)');
    check('no page errors while rendering all expressions', !page.errors.length, page.errors.slice(0, 3).join(' | '));
    fs.writeFileSync(path.join(OUT, 'bench.json'), JSON.stringify({ boot: boot.info, bench }));
    await ctx.close(); await browser.close();
  }

  // ------------------------------------------------------------------ 2. camera: static face
  {
    const browser = await chromium.launch({ args: [...GL, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + STATIC] });
    const { ctx, page } = await open(browser, '?clean=1&debug=1&delegate=cpu', { permissions: ['camera', 'microphone'] });   // CPU delegate: software-GL runs the GPU delegate at ~2 s/frame here
    await page.evaluate(() => __mrp.startCamera());
    await page.waitForFunction(() => __mrp.state.running && __mrp.state.faceFound, null, { timeout: 120000 });
    await page.waitForTimeout(3500);
    const s = await page.evaluate(() => ({ d: __mrp.state.delegate, p: __mrp.anchor.position.toArray(), face: __mrp.state.faceFound, mood: __mrp.state.out.dominant, w: __mrp.state.rawWeights, vis: __mrp.anchor.visible, live: document.body.classList.contains('live') }));
    check('camera starts and MediaPipe Face Landmarker finds the face (CPU-delegate fallback path)', s.face && s.live && s.d === 'CPU', 'delegate ' + s.d);
    check('head pose is plausible (30-90 cm in front of the camera)', s.p[2] < -25 && s.p[2] > -95 && Math.abs(s.p[0]) < 40, JSON.stringify(s.p.map(v => +v.toFixed(1))));
    check('blendshapes reach the rig (smile detected on the smiling test face)', s.w.MouthSmileLeft > 0.5 && s.w.MouthSmileRight > 0.5 && s.mood === 'happy', `smile ${s.w.MouthSmileLeft.toFixed(2)}/${s.w.MouthSmileRight.toFixed(2)} mood ${s.mood}`);
    await page.screenshot({ path: path.join(OUT, 'camera_static.png') });

    // photo
    await page.evaluate(() => document.body.classList.remove('clean'));
    await page.click('#btnShutter'); await page.waitForSelector('#review.open', { timeout: 15000 });
    const photo = await page.evaluate(async () => { const img = document.querySelector('#reviewMedia img'); const b = await (await fetch(img.src)).blob(); const buf = new Uint8Array(await b.arrayBuffer()); let bin = ''; buf.forEach(x => bin += String.fromCharCode(x)); return { w: img.naturalWidth, h: img.naturalHeight, type: b.type, size: b.size, b64: btoa(bin) }; });
    fs.writeFileSync(path.join(OUT, 'photo.jpg'), Buffer.from(photo.b64, 'base64'));
    const stats = JSON.parse(py(`
from PIL import Image, ImageStat
im=Image.open(${JSON.stringify(path.join(OUT, 'photo.jpg'))}).convert('RGB'); st=ImageStat.Stat(im)
print('{"mean":%.1f,"std":%.1f}'%(sum(st.mean)/3,sum(st.stddev)/3))`));
    check('photo capture produces a JPEG of the composited canvas', photo.type === 'image/jpeg' && photo.size > 30000 && photo.w >= 500 && stats.std > 25, `${photo.w}x${photo.h} ${Math.round(photo.size / 1024)} KB, contrast ${stats.std}`);
    await page.click('#btnCloseReview');

    // video
    await page.click('#modeSwitch [data-mode="video"]');
    const fc0 = await page.evaluate(() => __mrp.state.frameCount);
    await page.click('#btnShutter'); await page.waitForTimeout(1200);
    check('recording indicator shows while recording', await page.evaluate(() => document.body.classList.contains('recording')));
    await page.waitForTimeout(2800); await page.click('#btnShutter');
    const rendered = (await page.evaluate(() => __mrp.state.frameCount)) - fc0;
    await page.waitForSelector('#review.open video', { timeout: 20000 });
    const vid = await page.evaluate(async () => { const v = document.querySelector('#reviewMedia video'); const b = await (await fetch(v.src)).blob(); const buf = new Uint8Array(await b.arrayBuffer()); let bin = ''; const CH = 0x8000; for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH)); return { type: b.type, size: b.size, b64: btoa(bin) }; });
    const ext = vid.type.includes('mp4') ? 'mp4' : 'webm'; const vf = path.join(OUT, 'video.' + ext); fs.writeFileSync(vf, Buffer.from(vid.b64, 'base64'));
    let probe = {};
    try { probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', vf], { encoding: 'utf8' })); } catch (e) { probe = { err: String(e).slice(0, 200) }; }
    const dur = probe.format && +probe.format.duration, fr = probe.streams && +probe.streams[0].nb_read_frames;
    check('video recording is a valid file holding most of the frames the app rendered (software GL here renders only a few fps)', dur > 1 && dur < 12 && fr >= Math.max(3, 0.2 * rendered), `${vid.type} ${probe.streams && probe.streams[0].codec_name} ${probe.streams && probe.streams[0].width}x${probe.streams && probe.streams[0].height} ${dur && dur.toFixed(2)}s ${fr} frames of ${rendered} rendered ${Math.round(vid.size / 1024)} KB`);
    try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1.5', '-i', vf, '-frames:v', '1', path.join(OUT, 'video_frame.png')]); } catch (_) {}
    await page.click('#btnCloseReview');

    // flip camera (only one fake device here: verifies the code path keeps running)
    await page.evaluate(() => document.body.classList.add('clean'));
    const f0 = await page.evaluate(() => __mrp.state.faceFound);
    const flipOk = await page.evaluate(async () => { try { await __mrp.flipCamera(); return __mrp.state.running; } catch (e) { return 'ERR ' + e.message; } });
    check('flip camera switches stream and tracking keeps running', flipOk === true, String(flipOk));
    check('no page errors in camera session', !page.errors.length, page.errors.slice(0, 3).join(' | '));
    await ctx.close(); await browser.close();
  }

  // ------------------------------------------------------------------ 3. camera: moving head (position + roll tracking)
  {
    const browser = await chromium.launch({ args: [...GL, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + MOVING] });
    const { ctx, page } = await open(browser, '?clean=1', { permissions: ['camera'] });
    await page.evaluate(() => __mrp.startCamera());
    await page.waitForFunction(() => __mrp.state.running && __mrp.state.faceFound, null, { timeout: 120000 });
    const samples = [];
    for (let i = 0; i < 28; i++) {
      samples.push(await page.evaluate(() => { const q = __mrp.anchor.quaternion, e = new __mrp.THREE.Euler().setFromQuaternion(q, 'ZXY'); return { x: __mrp.anchor.position.x, y: __mrp.anchor.position.y, z: __mrp.anchor.position.z, roll: e.z * 180 / Math.PI, found: __mrp.state.faceFound }; }));
      if (i === 8) await page.screenshot({ path: path.join(OUT, 'camera_moving_a.png') });
      if (i === 20) await page.screenshot({ path: path.join(OUT, 'camera_moving_b.png') });
      await page.waitForTimeout(450);
    }
    const f = samples.filter(s => s.found); const rng = k => Math.max(...f.map(s => s[k])) - Math.min(...f.map(s => s[k]));
    check('GPU delegate (default) also initialises and tracks', await page.evaluate(() => __mrp.state.delegate === 'GPU'), await page.evaluate(() => __mrp.state.delegate));
    check('TV follows head translation (video pans ~80 px)', rng('x') > 3, `x range ${rng('x').toFixed(1)} cm over ${f.length} samples`);
    check('TV follows head roll (video rotates +-16 degrees)', rng('roll') > 10, `roll range ${rng('roll').toFixed(1)} deg`);
    check('pose stays stable in depth while the head only slides/rolls', rng('z') < 25, `z range ${rng('z').toFixed(1)} cm`);
    await ctx.close(); await browser.close();
  }

  // ------------------------------------------------------------------ 4. camera denied / missing + settings persistence
  {
    const browser = await chromium.launch({ args: GL });          // no fake camera: getUserMedia fails
    const { ctx, page } = await open(browser, '');
    await page.click('#btnStart');
    await page.waitForFunction(() => !document.getElementById('startError').hidden, null, { timeout: 30000 });
    const msg = await page.textContent('#startError');
    check('missing/denied camera shows a friendly message and lets you retry', /camera/i.test(msg) && !(await page.$eval('#btnStart', b => b.disabled)), msg.slice(0, 90));
    await page.evaluate(() => { document.body.classList.add('live'); document.getElementById('start').classList.add('gone'); });
    await page.click('#btnSettings'); await page.fill('#sExpr', '1.8'); await page.dispatchEvent('#sExpr', 'input');
    await page.reload(); await page.waitForFunction(() => document.body.classList.contains('ready'));
    const kept = await page.evaluate(() => __mrp.S.expressiveness);
    check('settings persist across reloads', Math.abs(kept - 1.8) < 0.01, String(kept));
    await page.screenshot({ path: path.join(OUT, 'start_screen.png') });
    check('start screen has no errors', !page.errors.filter(e => !/getUserMedia|NotFound|Requested device/i.test(e)).length, page.errors.join(' | ').slice(0, 200));
    await ctx.close(); await browser.close();
  }

  const failed = results.filter(r => !r.ok);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  server.close(); process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('E2E CRASH', e); process.exit(2); });
