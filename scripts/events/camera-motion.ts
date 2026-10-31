import { getFrameDimensions, type Detection, type FrameSource, type Point } from "../core/detections";
import { identityMotion, type CameraTransform } from "./types";
import { fitCameraMotion } from "./camera-fit";
interface Mat { rows: number; cols: number; data: Uint8Array; data32F: Float32Array; delete(): void }
interface CV {
  Mat: { new(): Mat; new(rows: number, cols: number, type: number): Mat };
  Size: new(width: number, height: number) => unknown;
  CV_8UC1: number; COLOR_RGBA2GRAY: number;
  imread(source: HTMLCanvasElement): Mat;
  cvtColor(source: Mat, dest: Mat, code: number): void;
  goodFeaturesToTrack(image: Mat, points: Mat, count: number, quality: number, distance: number, mask: Mat, blockSize: number): void;
  calcOpticalFlowPyrLK(previous: Mat, current: Mat, points: Mat, next: Mat, status: Mat, error: Mat, size: unknown, levels: number): void;
}
let cvPromise: Promise<{ api: CV }> | null = null;
function loadCV(): Promise<{ api: CV }> {
  if (!cvPromise) cvPromise = new Promise<{ api: CV }>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("../../vendor/opencv.js", import.meta.url).href;
    const timeout = window.setTimeout(() => { script.remove(); reject(new Error("OpenCV loading timed out")); }, 60000);
    script.onerror = () => { clearTimeout(timeout); reject(new Error("Could not load vendor/opencv.js for camera motion")); };
    script.onload = () => {
      const module = (globalThis as unknown as { cv: CV & { then?: (callback: (api: CV) => void) => void } }).cv;
      const ready = (api: CV) => {
        clearTimeout(timeout);
        if (!api?.Mat || !api.calcOpticalFlowPyrLK) reject(new Error("The OpenCV build does not support optical flow"));
        else resolve({ api });
      };
      if (module?.Mat) ready(module);
      else if (module?.then) module.then(ready);
      else { clearTimeout(timeout); reject(new Error("OpenCV did not initialise")); }
    };
    document.head.append(script);
  }).catch(error => { cvPromise = null; throw error; });
  return cvPromise;
}
function histogram(gray: Mat, mask: Mat): number[] {
  const bins = Array(32).fill(0); let total = 0;
  for (let i = 0; i < gray.data.length; i++) if (mask.data[i]) { bins[gray.data[i] >> 3]++; total++; }
  return bins.map(n => n / Math.max(total, 1));
}
export class CameraMotion {
  private cv: CV | null = null;
  private previous: Mat | null = null;
  private mask: Mat | null = null;
  private scale = 0;
  private canvas = document.createElement("canvas");
  private context = this.canvas.getContext("2d", { willReadFrequently: true })!;
  async load(): Promise<void> { this.cv = (await loadCV()).api; }
  reset(): void { this.previous?.delete(); this.mask?.delete(); this.previous = this.mask = null; this.scale = 0; }
  update(source: FrameSource, detections: Detection[]): CameraTransform {
    if (!this.cv) throw new Error("Camera motion is not loaded");
    const cv = this.cv, { width, height } = getFrameDimensions(source), scale = Math.min(1, 640 / width);
    this.canvas.width = Math.round(width * scale); this.canvas.height = Math.round(height * scale);
    this.context.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
    const rgba = cv.imread(this.canvas), gray = new cv.Mat(), mask = new cv.Mat(this.canvas.height, this.canvas.width, cv.CV_8UC1);
    try { cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY); } finally { rgba.delete(); }
    mask.data.fill(255);
    const w = gray.cols, h = gray.rows, border = Math.max(4, Math.floor(Math.min(w, h) * .025));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < border || y < border || x >= w - border || y >= h - border) mask.data[y * w + x] = 0;
    for (const d of detections) if (d.classId === 0 || d.classId === 1) {
      const b = d.box, pad = Math.max(5, (b[2] - b[0]) * .12);
      const x1 = Math.max(0, Math.floor((b[0] - pad) * scale)), x2 = Math.min(w, Math.ceil((b[2] + pad) * scale));
      const y1 = Math.max(0, Math.floor((b[1] - pad) * scale)), y2 = Math.min(h, Math.ceil((b[3] + pad) * scale));
      for (let y = y1; y < y2; y++) mask.data.fill(0, y * w + x1, y * w + x2);
    }
    let result = identityMotion();
    const temporaries: Mat[] = [];
    const mat = () => { const m = new cv.Mat(); temporaries.push(m); return m; };
    try {
      if (this.previous && this.mask && this.previous.rows === h && this.previous.cols === w && this.scale === scale) {
        result.reason = "insufficient_background";
        const points = mat(); cv.goodFeaturesToTrack(this.previous, points, 500, .01, 8, this.mask, 7);
        if (points.rows >= 12) {
          const next = mat(), status = mat(), err = mat(), back = mat(), backStatus = mat(), backErr = mat(), size = new cv.Size(25, 25), levels = Math.min(w, h) >= 400 ? 3 : 2;
          cv.calcOpticalFlowPyrLK(this.previous, gray, points, next, status, err, size, levels);
          cv.calcOpticalFlowPyrLK(gray, this.previous, next, back, backStatus, backErr, size, levels);
          const a: Point[] = [], b: Point[] = [];
          for (let i = 0; i < points.rows; i++) {
            const x = next.data32F[i * 2], y = next.data32F[i * 2 + 1], ix = Math.round(x), iy = Math.round(y);
            if (!status.data[i] || !backStatus.data[i] || ix < 0 || iy < 0 || ix >= w || iy >= h || !mask.data[iy * w + ix]) continue;
            if (Math.hypot(back.data32F[i * 2] - points.data32F[i * 2], back.data32F[i * 2 + 1] - points.data32F[i * 2 + 1]) >= 1.5) continue;
            a.push([points.data32F[i * 2], points.data32F[i * 2 + 1]]); b.push([x, y]);
          }
          result = fitCameraMotion(a, b, w, h, scale);
        }
        if (!result.valid) {
          const first = histogram(this.previous, this.mask), second = histogram(gray, mask);
          const change = Math.sqrt(Math.max(0, 1 - first.reduce((sum, value, i) => sum + Math.sqrt(value * second[i]), 0)));
          if (change > .65) { result.sceneCut = true; result.reason = "appearance_cut"; }
        }
      }
    } finally {
      for (const m of temporaries) m.delete();
      this.previous?.delete(); this.mask?.delete(); this.previous = gray; this.mask = mask; this.scale = scale;
    }
    return result;
  }
}
