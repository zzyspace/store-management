// Camera lifetime is independent of the decode loop: confirmation never stops tracks.
export class CouponScanner {
  constructor({ video, onCode, onError }) {
    this.video = video;
    this.onCode = onCode;
    this.onError = onError;
    this.canvas = document.createElement("canvas");
    this.context = this.canvas.getContext("2d", { willReadFrequently: true });
    this.generation = 0;
  }

  async start() {
    this.stop();
    const generation = this.generation;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) throw new Error("请通过 HTTPS 或本机地址打开页面以使用相机。");
      if (typeof window.jsQR !== "function") throw new Error("扫码组件加载失败，请刷新页面后重试。");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return false; }
      this.stream = stream;
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
        if (this.stream === stream) this.fail("相机已中断，已确认的券码仍保留，请重试。");
      }, { once: true }));
      this.video.srcObject = stream;
      await this.video.play();
      if (generation !== this.generation) return false;
      this.paused = false;
      this.lastCode = null;
      this.emptyFrames = 0;
      this.schedule(generation);
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      const messages = {
        NotAllowedError: "未获得相机权限，请在浏览器设置中允许使用相机后重试。",
        NotFoundError: "未找到可用相机，请使用带摄像头的设备。",
        NotReadableError: "相机无法启动，可能被其他应用占用，请关闭占用后重试。",
      };
      this.fail(messages[error.name] || error.message || "相机启动失败，请重试。");
      return false;
    }
  }

  schedule(generation) {
    this.timer = setTimeout(() => this.tick(generation), 150);
  }

  tick(generation) {
    if (generation !== this.generation || !this.stream) return;
    try {
      if (!this.paused && this.video.readyState >= 2 && this.video.videoWidth) {
        const scale = Math.min(1, 960 / this.video.videoWidth);
        this.canvas.width = Math.round(this.video.videoWidth * scale);
        this.canvas.height = Math.round(this.video.videoHeight * scale);
        this.context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
        const frame = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
        const result = window.jsQR(frame.data, frame.width, frame.height);
        if (!result) {
          if (++this.emptyFrames >= 3) this.lastCode = null;
        } else {
          this.emptyFrames = 0;
          const code = result.data.trim();
          if (code !== this.lastCode) {
            this.lastCode = code;
            this.paused = true;
            this.onCode(result.data);
          }
        }
      }
    } catch { this.fail("二维码识别发生异常，已确认的券码仍保留，请重试。"); return; }
    if (generation === this.generation) this.schedule(generation);
  }

  resume() { this.paused = false; }

  fail(message) {
    this.stop();
    this.onError(message);
  }

  stop() {
    ++this.generation;
    clearTimeout(this.timer);
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks().forEach((track) => track.stop());
    this.video.pause();
    this.video.srcObject = null;
    this.paused = true;
  }
}
