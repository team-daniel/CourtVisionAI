import type { Point } from "../core/detections";
import { identityMotion, type Affine, type CameraTransform } from "./types";
function fit(a: Point[], b: Point[], indices: number[]): Affine | null {
  const n = indices.length;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (const i of indices) { ax += a[i][0]; ay += a[i][1]; bx += b[i][0]; by += b[i][1]; }
  ax /= n; ay /= n; bx /= n; by /= n;
  let denom = 0, real = 0, imaginary = 0;
  for (const i of indices) {
    const x = a[i][0] - ax, y = a[i][1] - ay, u = b[i][0] - bx, v = b[i][1] - by;
    denom += x * x + y * y; real += x * u + y * v; imaginary += x * v - y * u;
  }
  if (denom < 1e-9) return null;
  const c = real / denom, s = imaginary / denom;
  return [[c, -s, bx - c * ax + s * ay], [s, c, by - s * ax - c * ay]];
}
const error = (a: Point, b: Point, m: Affine) => Math.hypot(m[0][0] * a[0] + m[0][1] * a[1] + m[0][2] - b[0], m[1][0] * a[0] + m[1][1] * a[1] + m[1][2] - b[1]);
export function fitCameraMotion(a: Point[], b: Point[], width: number, height: number, scale: number): CameraTransform {
  const result = { ...identityMotion(), reason: "insufficient_background" };
  if (a.length < 12) return result;
  let best: number[] = [], seed = 12345;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let trial = 0; trial < 2000; trial++) {
    const i = Math.floor(random() * a.length), j = Math.floor(random() * a.length);
    if (i === j) continue;
    const m = fit(a, b, [i, j]); if (!m) continue;
    const keep = a.map((p, k) => error(p, b[k], m) <= 2 ? k : -1).filter(k => k >= 0);
    if (keep.length > best.length) best = keep;
    if (best.length === a.length) break;
  }
  if (best.length < 12 || best.length / a.length < .6) return result;
  let matrix = fit(a, b, best)!;
  best = a.map((p, k) => error(p, b[k], matrix) <= 2 ? k : -1).filter(k => k >= 0);
  if (best.length < 12 || best.length / a.length < .6) return result;
  matrix = fit(a, b, best)!;
  const xs = best.map(i => a[i][0]), ys = best.map(i => a[i][1]);
  const zoom = Math.hypot(matrix[0][0], matrix[1][0]), angle = Math.abs(Math.atan2(matrix[1][0], matrix[0][0]));
  if (Math.max(...xs) - Math.min(...xs) <= .2 * width || Math.max(...ys) - Math.min(...ys) <= .15 * height || zoom <= .85 || zoom >= 1.18 || angle >= .15) return result;
  const errors = best.map(i => error(a[i], b[i], matrix)).sort((x, y) => x - y), mid = Math.floor(errors.length / 2);
  const residual = (errors.length % 2 ? errors[mid] : (errors[mid - 1] + errors[mid]) / 2) / scale;
  matrix[0][2] /= scale; matrix[1][2] /= scale;
  return { valid: true, matrix, residual, inliers: best.length, sceneCut: false, reason: "background_flow" };
}
