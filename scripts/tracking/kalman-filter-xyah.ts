/*
 * Behavioural TypeScript port of Ultralytics 8.4.92 KalmanFilterXYAH.
 * Upstream source is AGPL-3.0 licensed.
 */

export type Vector = number[];
export type Matrix = number[][];

export interface GaussianState {
  mean: Vector;
  covariance: Matrix;
}

export class KalmanFilterXYAH {
  private readonly motionMatrix: Matrix;
  private readonly updateMatrix: Matrix;
  private readonly positionWeight = 1 / 20;
  private readonly velocityWeight = 1 / 160;

  constructor() {
    this.motionMatrix = identityMatrix(8);

    for (let index = 0; index < 4; index += 1) {
      this.motionMatrix[index][4 + index] = 1;
    }

    this.updateMatrix = zeroMatrix(4, 8);

    for (let index = 0; index < 4; index += 1) {
      this.updateMatrix[index][index] = 1;
    }
  }

  initiate(measurement: readonly number[]): GaussianState {
    const mean = [
      measurement[0],
      measurement[1],
      measurement[2],
      measurement[3],
      0,
      0,
      0,
      0,
    ];

    const height = measurement[3];
    const standardDeviation = [
      2 * this.positionWeight * height,
      2 * this.positionWeight * height,
      1e-2,
      2 * this.positionWeight * height,
      10 * this.velocityWeight * height,
      10 * this.velocityWeight * height,
      1e-5,
      10 * this.velocityWeight * height,
    ];

    return {
      mean,
      covariance: diagonalMatrix(
        standardDeviation.map((value) => value * value),
      ),
    };
  }

  predict(
    inputMean: readonly number[],
    inputCovariance: Matrix,
  ): GaussianState {
    const height = inputMean[3];
    const positionDeviation = [
      this.positionWeight * height,
      this.positionWeight * height,
      1e-2,
      this.positionWeight * height,
    ];

    const velocityDeviation = [
      this.velocityWeight * height,
      this.velocityWeight * height,
      1e-5,
      this.velocityWeight * height,
    ];

    const motionCovariance = diagonalMatrix(
      [...positionDeviation, ...velocityDeviation]
        .map((value) => value * value),
    );

    const mean = multiplyMatrixVector(
      this.motionMatrix,
      inputMean,
    );

    const covariance = addMatrices(
      multiplyMatrices(
        multiplyMatrices(
          this.motionMatrix,
          inputCovariance,
        ),
        transpose(this.motionMatrix),
      ),
      motionCovariance,
    );

    return { mean, covariance };
  }

  project(
    mean: readonly number[],
    covariance: Matrix,
  ): GaussianState {
    const height = mean[3];
    const standardDeviation = [
      this.positionWeight * height,
      this.positionWeight * height,
      1e-1,
      this.positionWeight * height,
    ];

    const innovationCovariance = diagonalMatrix(
      standardDeviation.map((value) => value * value),
    );

    const projectedMean = multiplyMatrixVector(
      this.updateMatrix,
      mean,
    );

    const projectedCovariance = addMatrices(
      multiplyMatrices(
        multiplyMatrices(
          this.updateMatrix,
          covariance,
        ),
        transpose(this.updateMatrix),
      ),
      innovationCovariance,
    );

    return {
      mean: projectedMean,
      covariance: projectedCovariance,
    };
  }

  update(
    mean: readonly number[],
    covariance: Matrix,
    measurement: readonly number[],
  ): GaussianState {
    const projected = this.project(mean, covariance);
    const covarianceTimesObservationTranspose = multiplyMatrices(
      covariance,
      transpose(this.updateMatrix),
    );

    const gain = multiplyMatrices(
      covarianceTimesObservationTranspose,
      inverseMatrix(projected.covariance),
    );

    const innovation = measurement.map(
      (value, index) => value - projected.mean[index],
    );

    const correctedMean = mean.map(
      (value, index) => (
        value
        + gain[index].reduce(
          (total, gainValue, measurementIndex) => (
            total + gainValue * innovation[measurementIndex]
          ),
          0,
        )
      ),
    );

    const correctedCovariance = subtractMatrices(
      covariance,
      multiplyMatrices(
        multiplyMatrices(gain, projected.covariance),
        transpose(gain),
      ),
    );

    return {
      mean: correctedMean,
      covariance: symmetrise(correctedCovariance),
    };
  }
}

export function zeroMatrix(
  rows: number,
  columns: number,
): Matrix {
  return Array.from(
    { length: rows },
    () => Array.from({ length: columns }, () => 0),
  );
}

export function identityMatrix(size: number): Matrix {
  const result = zeroMatrix(size, size);

  for (let index = 0; index < size; index += 1) {
    result[index][index] = 1;
  }

  return result;
}

export function diagonalMatrix(values: readonly number[]): Matrix {
  const result = zeroMatrix(values.length, values.length);

  for (let index = 0; index < values.length; index += 1) {
    result[index][index] = values[index];
  }

  return result;
}

export function transpose(matrix: Matrix): Matrix {
  if (matrix.length === 0) {
    return [];
  }

  return Array.from(
    { length: matrix[0].length },
    (_, column) => matrix.map((row) => row[column]),
  );
}

export function multiplyMatrices(
  left: Matrix,
  right: Matrix,
): Matrix {
  if (left.length === 0 || right.length === 0) {
    return [];
  }

  const innerSize = right.length;
  const columns = right[0].length;
  const result = zeroMatrix(left.length, columns);

  for (let row = 0; row < left.length; row += 1) {
    for (let inner = 0; inner < innerSize; inner += 1) {
      const leftValue = left[row][inner];

      if (leftValue === 0) {
        continue;
      }

      for (let column = 0; column < columns; column += 1) {
        result[row][column] += leftValue * right[inner][column];
      }
    }
  }

  return result;
}

export function multiplyMatrixVector(
  matrix: Matrix,
  vector: readonly number[],
): Vector {
  return matrix.map((row) => (
    row.reduce(
      (total, value, index) => total + value * vector[index],
      0,
    )
  ));
}

export function addMatrices(
  left: Matrix,
  right: Matrix,
): Matrix {
  return left.map((row, rowIndex) => (
    row.map(
      (value, columnIndex) => value + right[rowIndex][columnIndex],
    )
  ));
}

export function subtractMatrices(
  left: Matrix,
  right: Matrix,
): Matrix {
  return left.map((row, rowIndex) => (
    row.map(
      (value, columnIndex) => value - right[rowIndex][columnIndex],
    )
  ));
}

export function inverseMatrix(matrix: Matrix): Matrix {
  const size = matrix.length;
  const augmented = matrix.map((row, rowIndex) => [
    ...row,
    ...identityMatrix(size)[rowIndex],
  ]);

  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;

    for (let candidate = column + 1; candidate < size; candidate += 1) {
      if (
        Math.abs(augmented[candidate][column])
        > Math.abs(augmented[pivotRow][column])
      ) {
        pivotRow = candidate;
      }
    }

    if (Math.abs(augmented[pivotRow][column]) < 1e-12) {
      augmented[pivotRow][column] += 1e-7;
    }

    [augmented[column], augmented[pivotRow]] = [
      augmented[pivotRow],
      augmented[column],
    ];

    const pivot = augmented[column][column];

    for (let index = 0; index < size * 2; index += 1) {
      augmented[column][index] /= pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) {
        continue;
      }

      const factor = augmented[row][column];

      for (let index = 0; index < size * 2; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }

  return augmented.map((row) => row.slice(size));
}

function symmetrise(matrix: Matrix): Matrix {
  return matrix.map((row, rowIndex) => (
    row.map((value, columnIndex) => (
      (value + matrix[columnIndex][rowIndex]) / 2
    ))
  ));
}
