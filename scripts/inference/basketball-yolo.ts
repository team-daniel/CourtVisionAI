import { getFrameDimensions, overlap, type ClassId, type Detection, type FrameSource } from "../core/detections";
import { OnnxModel } from "./onnx-model";
import { decodeYolo } from "./yolo-output";
export interface BasketballYoloOptions { modelUrl?: string }
export class BasketballYolo {
  private model: OnnxModel;
  private canvas = document.createElement("canvas");
  private context = this.canvas.getContext("2d", { willReadFrequently: true })!;
  outputShape: number[] = [];
  constructor(options: BasketballYoloOptions = {}) { this.model = new OnnxModel(options.modelUrl ?? new URL("../../models/yolo26s_basketball_v2_1280.onnx", import.meta.url).href); }
  get executionProvider(): string { return this.model.executionProvider; }
  async load(): Promise<void> {
    await this.model.load();
    for (const size of [1280, 1600]) {
      try {
        const result = await this.model.run(new Float32Array(3 * size * size).fill(114 / 255), [1, 3, size, size]);
        decodeYolo(result.data, result.dims, { width: size, height: size, scale: 1, left: 0, top: 0 }, [0, 1, 2], .15);
      } catch (error) { throw new Error(`YOLO could not run at ${size}×${size}. Use the dynamic float32 ONNX export. ${error instanceof Error ? error.message : error}`); }
    }
  }
  private async pass(source: FrameSource, size: number, classes: ClassId[], confidence: number): Promise<Detection[]> {
    const { width, height } = getFrameDimensions(source), scale = Math.min(size / width, size / height);
    const resizedWidth = Math.round(width * scale), resizedHeight = Math.round(height * scale);
    const inputWidth = Math.ceil(resizedWidth / 32) * 32, inputHeight = Math.ceil(resizedHeight / 32) * 32;
    const left = Math.round((inputWidth - resizedWidth) / 2 - .1), top = Math.round((inputHeight - resizedHeight) / 2 - .1);
    this.canvas.width = inputWidth; this.canvas.height = inputHeight;
    this.context.fillStyle = "rgb(114,114,114)"; this.context.fillRect(0, 0, inputWidth, inputHeight);
    this.context.drawImage(source, 0, 0, width, height, left, top, resizedWidth, resizedHeight);
    const pixels = this.context.getImageData(0, 0, inputWidth, inputHeight).data, area = inputWidth * inputHeight, input = new Float32Array(3 * area);
    for (let i = 0; i < area; i++) { input[i] = pixels[4 * i] / 255; input[area + i] = pixels[4 * i + 1] / 255; input[2 * area + i] = pixels[4 * i + 2] / 255; }
    const result = await this.model.run(input, [1, 3, inputHeight, inputWidth]); this.outputShape = result.dims;
    return decodeYolo(result.data, result.dims, { width, height, scale, left, top }, classes, confidence);
  }
  async detect(source: FrameSource): Promise<Detection[]> {
    const people = await this.pass(source, 1280, [1, 2], .15), balls = await this.pass(source, 1600, [0], .20);
    const result: Detection[] = [];
    for (const d of [...people, ...balls].sort((a, b) => b.confidence - a.confidence)) if (!result.some(k => k.classId === d.classId && overlap(k.box, d.box) > .75)) result.push(d);
    return result.slice(0, 80);
  }
  async dispose(): Promise<void> { await this.model.dispose(); this.canvas.width = this.canvas.height = 1; }
}
