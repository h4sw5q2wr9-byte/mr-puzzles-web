// Photo + video capture straight from the WebGL canvas (video background + 3D head are already composited there).
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const list = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {} }
  return '';          // let the browser choose
}

export class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.rec = null; this.chunks = []; this.mime = null; this.startedAt = 0; this.micStream = null;
  }
  static get videoSupported() { return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream; }
  get recording() { return !!this.rec && this.rec.state === 'recording'; }
  get elapsed() { return this.recording ? (performance.now() - this.startedAt) / 1000 : 0; }

  /** Call right after renderer.render() in the same task: the drawing buffer is still valid. */
  photoBlob(type = 'image/jpeg', quality = 0.92) {
    return new Promise((resolve, reject) => this.canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality));
  }

  async startVideo({ audio = false, fps = 30, bitrate = 6_000_000 } = {}) {
    if (!Recorder.videoSupported) throw new Error('Video recording is not supported in this browser');
    const stream = this.canvas.captureStream(fps);
    if (audio) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this.micStream.getAudioTracks().forEach(t => stream.addTrack(t));
      } catch (e) { console.warn('microphone unavailable, recording silent video', e); }
    }
    this.mime = pickMime();
    const opts = { videoBitsPerSecond: bitrate };
    if (this.mime) opts.mimeType = this.mime;
    this.rec = new MediaRecorder(stream, opts);
    this.chunks = [];
    this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(250);
    this.startedAt = performance.now();
  }

  stopVideo() {
    return new Promise((resolve, reject) => {
      if (!this.rec) return reject(new Error('not recording'));
      const rec = this.rec;
      rec.onstop = () => {
        const type = rec.mimeType || this.mime || 'video/mp4';
        const blob = new Blob(this.chunks, { type });
        this.rec = null; this.chunks = [];
        if (this.micStream) { this.micStream.getTracks().forEach(t => t.stop()); this.micStream = null; }
        rec.stream.getTracks().forEach(t => t.stop());
        resolve(blob);
      };
      rec.onerror = e => reject(e.error || new Error('recorder error'));
      try { rec.stop(); } catch (e) { reject(e); }
    });
  }
}

export function extFor(blob) {
  const t = blob.type || '';
  if (t.includes('mp4')) return 'mp4';
  if (t.includes('webm')) return 'webm';
  if (t.includes('png')) return 'png';
  return t.includes('jpeg') ? 'jpg' : 'bin';
}
