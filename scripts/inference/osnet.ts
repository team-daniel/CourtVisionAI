import { getFrameDimensions, type BoundingBox, type FrameSource } from "../core/detections";
import { normalise } from "../tracking/deep-eiou";
import { OnnxModel } from "./onnx-model";
export class OSNetEncoder {
  private model: OnnxModel;
  private canvas = document.createElement("canvas");
  private context = this.canvas.getContext("2d", { willReadFrequently: true })!;
  constructor(url = new URL("../../models/osnet_sports.onnx", import.meta.url).href) { this.model = new OnnxModel(url); this.canvas.width = 128; this.canvas.height = 256; }
  get executionProvider(): string { return this.model.executionProvider; }
  async load(): Promise<void> {
    await this.model.load();
    const result = await this.model.run(new Float32Array(3 * 128 * 256), [1, 3, 256, 128]);
    if (result.dims.length !== 2 || result.dims[0] !== 1 || result.dims[1] !== 512) throw new Error(`OSNet output must be [1,512], received [${result.dims}]`);
  }
  async encode(source: FrameSource, boxes: BoundingBox[]): Promise<number[][]> {
    const { width, height } = getFrameDimensions(source), result: number[][] = [];
    for (const box of boxes) {
      const [x1, y1, x2, y2] = [Math.max(0, Math.round(box[0])), Math.max(0, Math.round(box[1])), Math.min(width, Math.round(box[2])), Math.min(height, Math.round(box[3]))];
      if (x2 <= x1 || y2 <= y1) { result.push(Array(512).fill(0)); continue; }
      this.context.drawImage(source, x1, y1, x2 - x1, y2 - y1, 0, 0, 128, 256);
      const pixels = this.context.getImageData(0, 0, 128, 256).data, area = 128 * 256, input = new Float32Array(area * 3);
      for (let i = 0; i < area; i++) { input[i] = pixels[i * 4] / 255; input[area + i] = pixels[i * 4 + 1] / 255; input[area * 2 + i] = pixels[i * 4 + 2] / 255; }
      const output = await this.model.run(input, [1, 3, 256, 128]);
      if (output.data.length !== 512) throw new Error("Invalid OSNet embedding length");
      const feature = normalise(output.data);
      if (!feature) throw new Error("OSNet produced an invalid embedding");
      result.push(feature);
    }
    return result;
  }
  async dispose(): Promise<void> { await this.model.dispose(); }
}
