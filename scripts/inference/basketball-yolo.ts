import * as ort from "onnxruntime-web/webgpu";
import {
  CLASS_NAMES,
  type ClassId,
  type Detection,
  type FrameSource,
} from "../core/detections";

const INPUT_SIZE = 960;
const MAX_DETECTIONS = 10;

export type ExecutionProvider = "WebGPU" | "WASM";

export interface DetectionResult {
  detections: Detection[];
  inferenceMilliseconds: number;
  executionProvider: ExecutionProvider;
  outputShape: number[];
}

export interface BasketballYoloOptions {
  modelUrl?: string;
  confidence?: number;
}

interface PreparedInput {
  tensor: ort.Tensor;
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  padX: number;
  padY: number;
}

export class BasketballYolo {
  private readonly modelUrl: string;
  private readonly confidence: number;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;

  private session: ort.InferenceSession | null = null;
  private inputName = "";
  private outputName = "";
  private executionProvider: ExecutionProvider = "WASM";

  constructor({
    modelUrl = new URL(
      "../../models/yolo26n.onnx",
      import.meta.url,
    ).href,
    confidence = 0.25,
  }: BasketballYoloOptions = {}) {
    this.modelUrl = modelUrl;
    this.confidence = confidence;

    this.canvas = document.createElement("canvas");
    this.canvas.width = INPUT_SIZE;
    this.canvas.height = INPUT_SIZE;

    const context = this.canvas.getContext(
      "2d",
      { willReadFrequently: true },
    );

    if (!context) {
      throw new Error(
        "Could not create the model preprocessing canvas.",
      );
    }

    this.context = context;
  }

  async load(): Promise<void> {
    if (this.session) {
      return;
    }

    const supportsWebGpu = "gpu" in navigator;

    if (supportsWebGpu) {
      ort.env.webgpu.powerPreference = "high-performance";
    }

    try {
      if (!supportsWebGpu) {
        throw new Error("WebGPU is unavailable.");
      }

      this.session = await ort.InferenceSession.create(
        this.modelUrl,
        {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all",
        },
      );

      this.executionProvider = "WebGPU";
    } catch (webGpuError: unknown) {
      console.warn(
        "WebGPU session failed. Using WASM.",
        webGpuError,
      );

      this.session = await ort.InferenceSession.create(
        this.modelUrl,
        {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        },
      );

      this.executionProvider = "WASM";
    }

    const session = this.session;

    if (!session) {
      throw new Error("The ONNX model session was not created.");
    }

    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];

    if (!inputName || !outputName) {
      throw new Error(
        "The ONNX model does not expose a valid input and output.",
      );
    }

    this.inputName = inputName;
    this.outputName = outputName;

    console.log("Model loaded", {
      provider: this.executionProvider,
      inputNames: session.inputNames,
      outputNames: session.outputNames,
    });
  }

  async detect(
    source: FrameSource,
    confidence = this.confidence,
  ): Promise<DetectionResult> {
    await this.load();

    const session = this.session;

    if (!session || !this.inputName || !this.outputName) {
      throw new Error("The basketball model is not ready.");
    }

    const prepared = this.preprocess(source);

    const startedAt = performance.now();

    const outputs = await session.run({
      [this.inputName]: prepared.tensor,
    });

    const inferenceMilliseconds =
      performance.now() - startedAt;

    const output = outputs[this.outputName] as ort.Tensor | undefined;

    if (!output) {
      throw new Error(
        `The model did not return output: ${this.outputName}`,
      );
    }

    const detections = this.decodeOutput(
      output,
      prepared,
      confidence,
    );

    return {
      detections,
      inferenceMilliseconds,
      executionProvider: this.executionProvider,
      outputShape: Array.from(output.dims, Number),
    };
  }

  private preprocess(source: FrameSource): PreparedInput {
    const {
      width: sourceWidth,
      height: sourceHeight,
    } = getSourceDimensions(source);

    const scale = Math.min(
      INPUT_SIZE / sourceWidth,
      INPUT_SIZE / sourceHeight,
    );

    const resizedWidth = sourceWidth * scale;
    const resizedHeight = sourceHeight * scale;

    const padX = (INPUT_SIZE - resizedWidth) / 2;
    const padY = (INPUT_SIZE - resizedHeight) / 2;

    this.context.clearRect(
      0,
      0,
      INPUT_SIZE,
      INPUT_SIZE,
    );

    this.context.fillStyle = "rgb(114, 114, 114)";

    this.context.fillRect(
      0,
      0,
      INPUT_SIZE,
      INPUT_SIZE,
    );

    this.context.drawImage(
      source,
      0,
      0,
      sourceWidth,
      sourceHeight,
      padX,
      padY,
      resizedWidth,
      resizedHeight,
    );

    const imageData = this.context.getImageData(
      0,
      0,
      INPUT_SIZE,
      INPUT_SIZE,
    );

    const pixels = imageData.data;
    const planeSize = INPUT_SIZE * INPUT_SIZE;
    const inputData = new Float32Array(planeSize * 3);

    for (
      let pixelIndex = 0;
      pixelIndex < planeSize;
      pixelIndex += 1
    ) {
      const rgbaIndex = pixelIndex * 4;

      inputData[pixelIndex] =
        pixels[rgbaIndex] / 255;

      inputData[planeSize + pixelIndex] =
        pixels[rgbaIndex + 1] / 255;

      inputData[(planeSize * 2) + pixelIndex] =
        pixels[rgbaIndex + 2] / 255;
    }

    const tensor = new ort.Tensor(
      "float32",
      inputData,
      [1, 3, INPUT_SIZE, INPUT_SIZE],
    );

    return {
      tensor,
      sourceWidth,
      sourceHeight,
      scale,
      padX,
      padY,
    };
  }

  private decodeOutput(
    output: ort.Tensor,
    prepared: PreparedInput,
    confidenceThreshold: number,
  ): Detection[] {
    const dimensions = Array.from(output.dims, Number);

    console.log("ONNX output shape:", dimensions);

    const data = output.data as Float32Array;

    let numberOfRows: number;
    let valueAt: (row: number, column: number) => number;

    if (
      dimensions.length === 3
      && dimensions[2] === 6
    ) {
      numberOfRows = dimensions[1];
      const rowLength = 6;

      valueAt = (row, column) =>
        data[(row * rowLength) + column];
    } else if (
      dimensions.length === 2
      && dimensions[1] === 6
    ) {
      numberOfRows = dimensions[0];
      const rowLength = 6;

      valueAt = (row, column) =>
        data[(row * rowLength) + column];
    } else if (
      dimensions.length === 3
      && dimensions[1] === 6
    ) {
      numberOfRows = dimensions[2];

      valueAt = (row, column) =>
        data[(column * numberOfRows) + row];
    } else {
      throw new Error(
        [
          "Unexpected ONNX output shape:",
          JSON.stringify(dimensions),
          "Expected [1, N, 6], [N, 6], or [1, 6, N].",
        ].join(" "),
      );
    }

    const detections: Detection[] = [];

    for (let row = 0; row < numberOfRows; row += 1) {
      let x1 = Number(valueAt(row, 0));
      let y1 = Number(valueAt(row, 1));
      let x2 = Number(valueAt(row, 2));
      let y2 = Number(valueAt(row, 3));

      const confidence = Number(valueAt(row, 4));
      const rawClassId = Math.round(Number(valueAt(row, 5)));

      if (
        !Number.isFinite(confidence)
        || confidence < confidenceThreshold
      ) {
        continue;
      }

      if (!isClassId(rawClassId)) {
        continue;
      }

      const largestCoordinate = Math.max(
        Math.abs(x1),
        Math.abs(y1),
        Math.abs(x2),
        Math.abs(y2),
      );

      if (largestCoordinate <= 2) {
        x1 *= INPUT_SIZE;
        y1 *= INPUT_SIZE;
        x2 *= INPUT_SIZE;
        y2 *= INPUT_SIZE;
      }

      x1 = (x1 - prepared.padX) / prepared.scale;
      y1 = (y1 - prepared.padY) / prepared.scale;
      x2 = (x2 - prepared.padX) / prepared.scale;
      y2 = (y2 - prepared.padY) / prepared.scale;

      x1 = clamp(x1, 0, prepared.sourceWidth);
      y1 = clamp(y1, 0, prepared.sourceHeight);
      x2 = clamp(x2, 0, prepared.sourceWidth);
      y2 = clamp(y2, 0, prepared.sourceHeight);

      if (x2 <= x1 || y2 <= y1) {
        continue;
      }

      detections.push({
        classId: rawClassId,
        className: CLASS_NAMES[rawClassId],
        confidence,
        box: [x1, y1, x2, y2],
        trackId: null,
      });
    }

    detections.sort(
      (detectionA, detectionB) =>
        detectionB.confidence - detectionA.confidence,
    );

    return detections.slice(0, MAX_DETECTIONS);
  }
}

function getSourceDimensions(
  source: FrameSource,
): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) {
    if (!source.videoWidth || !source.videoHeight) {
      throw new Error(
        "The selected video frame has no valid dimensions.",
      );
    }

    return {
      width: source.videoWidth,
      height: source.videoHeight,
    };
  }

  if (source instanceof HTMLImageElement) {
    if (!source.naturalWidth || !source.naturalHeight) {
      throw new Error(
        "The selected image has no valid dimensions.",
      );
    }

    return {
      width: source.naturalWidth,
      height: source.naturalHeight,
    };
  }

  if (!source.width || !source.height) {
    throw new Error(
      "The selected source has no valid dimensions.",
    );
  }

  return {
    width: source.width,
    height: source.height,
  };
}

function isClassId(value: number): value is ClassId {
  return (
    value === 0
    || value === 1
    || value === 2
    || value === 3
    || value === 4
  );
}

function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(
    minimum,
    Math.min(value, maximum),
  );
}