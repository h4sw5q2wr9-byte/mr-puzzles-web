export const DEFAULTS = { expressiveness: 1.35, tvSize: 0.72, offsetY: -0.5, offsetZ: 7, mirrorAuto: true, body: true, secondary: true, debug: false, mic: false, quality: 'balanced' };
const KEY = 'mrpuzzles.settings.v1';
export function loadSettings() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (_) { return Object.assign({}, DEFAULTS); }
}
export function saveSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) { /* private mode */ } }
