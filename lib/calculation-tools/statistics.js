"use strict";

const MAX_VALUES = 100000;

function finiteNumbers(values, { min = 1 } = {}) {
  if (!Array.isArray(values)) throw new Error("숫자 배열이 필요합니다.");
  if (values.length > MAX_VALUES) throw new Error(`숫자는 최대 ${MAX_VALUES}개까지 처리할 수 있습니다.`);
  const numbers = values.map((value) => {
    if (value === null || value === undefined || String(value).trim() === "") return NaN;
    return Number(value);
  });
  if (numbers.some((value) => !Number.isFinite(value))) throw new Error("모든 값은 유효한 숫자여야 합니다.");
  if (numbers.length < min) throw new Error(`유효한 숫자가 ${min}개 이상 필요합니다.`);
  return numbers;
}

function quantile(sorted, q) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function describe(values) {
  const numbers = finiteNumbers(values);
  const sorted = [...numbers].sort((a, b) => a - b);
  const count = numbers.length;
  const sum = numbers.reduce((total, value) => total + value, 0);
  const mean = sum / count;
  const sumSquaredDeviation = numbers.reduce((total, value) => total + (value - mean) ** 2, 0);
  const frequencies = new Map();
  for (const value of numbers) frequencies.set(value, (frequencies.get(value) || 0) + 1);
  const maxFrequency = Math.max(...frequencies.values());
  const modes = maxFrequency > 1
    ? [...frequencies.entries()].filter(([, frequency]) => frequency === maxFrequency).map(([value]) => value)
    : [];
  return {
    count,
    sum,
    mean,
    min: sorted[0],
    q1: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    q3: quantile(sorted, 0.75),
    max: sorted[count - 1],
    range: sorted[count - 1] - sorted[0],
    variancePopulation: sumSquaredDeviation / count,
    standardDeviationPopulation: Math.sqrt(sumSquaredDeviation / count),
    varianceSample: count > 1 ? sumSquaredDeviation / (count - 1) : null,
    standardDeviationSample: count > 1 ? Math.sqrt(sumSquaredDeviation / (count - 1)) : null,
    modes,
  };
}

function linearRegression(xValues, yValues) {
  const x = finiteNumbers(xValues, { min: 2 });
  const y = finiteNumbers(yValues, { min: 2 });
  if (x.length !== y.length) throw new Error("x와 y의 유효한 숫자 개수가 같아야 합니다.");
  if (x.length > 10000) throw new Error("회귀 데이터는 최대 10,000쌍까지 처리할 수 있습니다.");
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) throw new Error("모든 x 값이 같아 회귀선을 계산할 수 없습니다.");
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const predictions = x.map((value) => slope * value + intercept);
  const residuals = y.map((value, index) => value - predictions[index]);
  const residualSumSquares = residuals.reduce((sum, value) => sum + value * value, 0);
  const rSquared = syy === 0 ? (residualSumSquares === 0 ? 1 : 0) : 1 - residualSumSquares / syy;
  const correlation = syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
  return {
    count: n,
    slope,
    intercept,
    rSquared,
    correlation,
    equation: `y = ${slope}x ${intercept < 0 ? "-" : "+"} ${Math.abs(intercept)}`,
    predictions,
    residuals,
    residualStandardError: n > 2 ? Math.sqrt(residualSumSquares / (n - 2)) : null,
  };
}

module.exports = { describe, finiteNumbers, linearRegression, quantile };
