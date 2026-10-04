export interface AssignmentResult {
  matches: Array<[number, number]>;
  unmatchedRows: number[];
  unmatchedColumns: number[];
}

interface CandidateResult {
  matches: Array<[number, number]>;
  count: number;
  cost: number;
}

/**
 * Cost-limited one-to-one assignment.
 *
 * Ultralytics uses LAPJV. The app normally has at most ten detections, so a
 * bitmask dynamic programme can optimise the same primary objective without a
 * native dependency: maximise valid matches, then minimise total cost.
 */
export function linearAssignment(
  costs: readonly (readonly number[])[],
  threshold: number,
  columnCountHint = 0,
): AssignmentResult {
  const rowCount = costs.length;
  const columnCount = rowCount > 0
    ? costs[0].length
    : columnCountHint;

  if (rowCount === 0 || columnCount === 0) {
    return {
      matches: [],
      unmatchedRows: Array.from(
        { length: rowCount },
        (_, index) => index,
      ),
      unmatchedColumns: Array.from(
        { length: columnCount },
        (_, index) => index,
      ),
    };
  }

  if (columnCount > 20) {
    throw new Error(
      "ByteTrack assignment supports at most 20 detections per frame.",
    );
  }

  const memo = new Map<string, CandidateResult>();

  const solve = (
    rowIndex: number,
    usedColumns: number,
  ): CandidateResult => {
    if (rowIndex >= rowCount) {
      return {
        matches: [],
        count: 0,
        cost: 0,
      };
    }

    const key = `${rowIndex}:${usedColumns}`;
    const cached = memo.get(key);

    if (cached) {
      return cached;
    }

    let best = solve(rowIndex + 1, usedColumns);

    for (
      let columnIndex = 0;
      columnIndex < columnCount;
      columnIndex += 1
    ) {
      const columnMask = 1 << columnIndex;
      const cost = costs[rowIndex][columnIndex];

      if (
        (usedColumns & columnMask) !== 0
        || !Number.isFinite(cost)
        || cost > threshold
      ) {
        continue;
      }

      const remainder = solve(
        rowIndex + 1,
        usedColumns | columnMask,
      );

      const candidate: CandidateResult = {
        matches: [
          [rowIndex, columnIndex],
          ...remainder.matches,
        ],
        count: remainder.count + 1,
        cost: remainder.cost + cost,
      };

      if (isBetter(candidate, best)) {
        best = candidate;
      }
    }

    memo.set(key, best);
    return best;
  };

  const result = solve(0, 0);
  const matchedRows = new Set(
    result.matches.map(([row]) => row),
  );
  const matchedColumns = new Set(
    result.matches.map(([, column]) => column),
  );

  return {
    matches: result.matches,
    unmatchedRows: Array.from(
      { length: rowCount },
      (_, index) => index,
    ).filter((index) => !matchedRows.has(index)),
    unmatchedColumns: Array.from(
      { length: columnCount },
      (_, index) => index,
    ).filter((index) => !matchedColumns.has(index)),
  };
}

function isBetter(
  candidate: CandidateResult,
  current: CandidateResult,
): boolean {
  if (candidate.count !== current.count) {
    return candidate.count > current.count;
  }

  if (Math.abs(candidate.cost - current.cost) > 1e-12) {
    return candidate.cost < current.cost;
  }

  return candidate.matches
    .map(([row, column]) => `${row}:${column}`)
    .join("|")
    < current.matches
      .map(([row, column]) => `${row}:${column}`)
      .join("|");
}
