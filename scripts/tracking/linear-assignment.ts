export interface AssignmentResult { matches: Array<[number, number]>; unmatchedRows: number[]; unmatchedColumns: number[] }

export function linearAssignment(costs: readonly (readonly number[])[], threshold: number, columnCountHint = 0): AssignmentResult {
  const rows = costs.length, columns = rows ? costs[0].length : columnCountHint, size = rows + columns;
  const matrix = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => {
    if (i >= rows && j >= columns) return 0;
    if (i >= rows || j >= columns) return threshold / 2;
    return Number.isFinite(costs[i][j]) && costs[i][j] <= threshold ? costs[i][j] : 1e6;
  }));
  const u = new Float64Array(size + 1), v = new Float64Array(size + 1), p = new Int32Array(size + 1), way = new Int32Array(size + 1);
  for (let i = 1; i <= size; i++) {
    p[0] = i;
    let j0 = 0;
    const min = new Float64Array(size + 1).fill(Infinity), used = new Uint8Array(size + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= size; j++) if (!used[j]) {
        const value = matrix[i0 - 1][j - 1] - u[i0] - v[j];
        if (value < min[j]) { min[j] = value; way[j] = j0; }
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      for (let j = 0; j <= size; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else min[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const matches: Array<[number, number]> = [];
  for (let j = 1; j <= columns; j++) if (p[j] > 0 && p[j] <= rows && costs[p[j] - 1][j - 1] <= threshold) matches.push([p[j] - 1, j - 1]);
  matches.sort((a, b) => a[0] - b[0]);
  return { matches, unmatchedRows: Array.from({ length: rows }, (_, i) => i).filter(i => !matches.some(m => m[0] === i)), unmatchedColumns: Array.from({ length: columns }, (_, j) => j).filter(j => !matches.some(m => m[1] === j)) };
}
