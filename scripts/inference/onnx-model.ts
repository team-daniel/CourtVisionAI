import * as ort from "onnxruntime-web/webgpu";

export class OnnxModel {
  private session: ort.InferenceSession | null = null;
  executionProvider = "not loaded";
  constructor(readonly url: string) {}
  async load(): Promise<void> {
    if (this.session) return;
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 2, 4) : 1;
    if ("gpu" in navigator) {
      try { this.session = await ort.InferenceSession.create(this.url, { executionProviders: ["webgpu"] }); this.executionProvider = "WebGPU"; return; }
      catch (error) { console.warn("WebGPU model loading failed; trying WebAssembly", error); }
    }
    await this.loadWasm();
  }
  private async loadWasm(): Promise<void> {
    this.session = await ort.InferenceSession.create(this.url, { executionProviders: ["wasm"] });
    this.executionProvider = "WASM";
  }
  async run(data: Float32Array, dimensions: number[]): Promise<{ data: Float32Array; dims: number[] }> {
    await this.load();
    const input = new ort.Tensor("float32", data, dimensions);
    let output: ort.InferenceSession.ReturnType | null = null;
    try {
      try { output = await this.session!.run({ [this.session!.inputNames[0]]: input }); }
      catch (error) {
        if (this.executionProvider !== "WebGPU") throw error;
        console.warn("WebGPU inference failed; retrying with WebAssembly", error);
        await this.session!.release(); this.session = null; await this.loadWasm();
        output = await this.session!.run({ [this.session!.inputNames[0]]: input });
      }
      const tensor = output[this.session!.outputNames[0]];
      if (tensor.type !== "float32") throw new Error(`Expected float32 output from ${this.url}, received ${tensor.type}`);
      return { data: Float32Array.from(tensor.data as Float32Array), dims: Array.from(tensor.dims) };
    } finally { input.dispose(); if (output) for (const tensor of Object.values(output)) tensor.dispose(); }
  }
  async dispose(): Promise<void> { const session = this.session; this.session = null; if (session) await session.release(); }
}
