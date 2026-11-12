// Camera access for iPhone Safari (needs HTTPS + a user gesture), with front/back flipping.
export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facing = 'user';
    this.devices = [];
  }

  static get supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

  async start(facing = this.facing) {
    this.stop();
    const constraints = {
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } }
    };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
    catch (e) {
      if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {   // relax and retry
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      } else throw e;
    }
    this.stream = stream;
    this.facing = facing;
    const v = this.video;
    v.srcObject = stream;
    v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    await v.play();
    if (!v.videoWidth) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
    const settings = stream.getVideoTracks()[0].getSettings();
    // what the browser actually gave us (a desktop with one webcam ignores facingMode)
    this.actualFacing = settings.facingMode || facing;
    try { this.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch (_) { this.devices = []; }
    return { width: v.videoWidth, height: v.videoHeight, facing: this.actualFacing, fps: settings.frameRate };
  }

  async flip() { return this.start(this.facing === 'user' ? 'environment' : 'user'); }

  get mirrored() { return this.actualFacing === 'user' || this.actualFacing === undefined; }

  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
