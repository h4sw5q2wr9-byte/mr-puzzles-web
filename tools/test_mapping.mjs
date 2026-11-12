// node tools/test_mapping.mjs : the MediaPipe adapter must supply every expression MoodLogic reads, and condition() must
// stop a broad smile from being read as anger / disgust.
import assert from 'node:assert';
import { MP_TO_LS, toLensNames, condition } from '../js/mp_map.js';
import { compute } from '../js/mood.js';
import { PRESETS } from '../js/demo_presets.js';

// 1. every key MoodLogic reads (probe with a Proxy) is produced by the adapter
const wanted = new Set();
const probe = new Proxy({}, { get: (_, k) => { if (typeof k === 'string') wanted.add(k); return 0; } });
compute(probe, { mirror: true });
const supplied = new Set([...Object.values(MP_TO_LS), 'UpperLipRaise']);
const missing = [...wanted].filter(k => !supplied.has(k));
assert.deepStrictEqual(missing, [], 'MoodLogic reads expressions MediaPipe does not provide: ' + missing.join(', '));
console.log(`ok: all ${wanted.size} expressions MoodLogic reads are provided by the MediaPipe adapter`);

// 2. MediaPipe's official 52 blendshape names are all known (nothing silently dropped except _neutral/tongueOut)
const MP52 = ['_neutral', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight', 'jawForward', 'jawLeft', 'jawOpen', 'jawRight', 'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut'];
const unknown = MP52.filter(n => !MP_TO_LS[n] && !['_neutral', 'tongueOut'].includes(n));
assert.deepStrictEqual(unknown, [], 'unmapped MediaPipe blendshapes: ' + unknown);
console.log('ok: all 52 MediaPipe blendshapes handled');

// 3. the real tracked values of a broad smile (measured on the test portrait) must read as HAPPY, not anger/disgust
const grin = { BrowsDownLeft: .77, BrowsDownRight: .76, EyeSquintLeft: .7, EyeSquintRight: .63, JawOpen: .1, MouthSmileLeft: .94, MouthSmileRight: .92, UpperLipUpLeft: .83, UpperLipUpRight: .81, UpperLipRaise: .83, MouthPressLeft: .16, MouthPressRight: .14, EyeBlinkLeft: .25, EyeBlinkRight: .25 };
const raw = compute({ ...grin }, { mirror: true });
const fixed = compute(condition({ BrowsDownLeft: 0, BrowsDownRight: 0, SneerLeft: 0, SneerRight: 0, UpperLipUpLeft: 0, UpperLipUpRight: 0, UpperLipRaise: 0, MouthSmileLeft: 0, MouthSmileRight: 0, ...grin }), { mirror: true });
console.log('   without conditioning:', raw.dominant, '| with conditioning:', fixed.dominant);
assert.strictEqual(fixed.dominant, 'happy'); assert.ok(fixed.mood.anger < 0.3 && fixed.mood.disgust < 0.3, 'smile still read as anger/disgust');
// ...but real anger (no smile) is untouched
const angry = condition({ BrowsDownLeft: .85, BrowsDownRight: .85, SneerLeft: .5, SneerRight: .5, MouthSmileLeft: 0, MouthSmileRight: 0, UpperLipRaise: 0, UpperLipUpLeft: 0, UpperLipUpRight: 0 });
assert.strictEqual(compute(angry, { mirror: true }).dominant, 'anger');
console.log('ok: conditioning keeps smiles happy and anger angry');
