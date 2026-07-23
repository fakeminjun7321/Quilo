const MODEL_PRICING = {
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: .3, cacheWrite: 3.75 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: .5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: .5, cacheWrite: 6.25 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: .5, cacheWrite: 5 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: .25, cacheWrite: 2.5 },
  "gpt-5.4-mini": { input: .75, output: 4.5, cacheRead: .075, cacheWrite: .75 },
};
const pricingFor = (modelId) => MODEL_PRICING[modelId] || MODEL_PRICING["claude-opus-4-8"];

export function estimateCost(pdfBytes, modelId) {
  const sizeKB = pdfBytes / 1024;
  const p = pricingFor(modelId);
  const baseLow = (10000 / 1e6) * p.cacheRead;
  const baseHigh = (10000 / 1e6) * p.cacheWrite;
  const inputLow = (sizeKB * 30 / 1e6) * p.input;
  const inputHigh = (sizeKB * 100 / 1e6) * p.input;
  const outputLow = (6000 / 1e6) * p.output;
  const outputHigh = (10000 / 1e6) * p.output;
  const isGpt = /^gpt/i.test(modelId || "");
  return {
    lo: baseLow + inputLow + outputLow + (isGpt ? 0 : .01),
    hi: baseHigh + inputHigh + outputHigh + (isGpt ? 0 : .03),
    sizeKB: Math.round(sizeKB),
  };
}

export function estimatePhysResultCost({ capBytes, photoCount, photoBytes, formBytes, rubricBytes, modelId }) {
  const p = pricingFor(modelId);
  const baseLow = (8000 / 1e6) * p.cacheRead;
  const baseHigh = (8000 / 1e6) * p.cacheWrite;
  const capCost = (Math.min((capBytes / 1024) * .3, 8000) / 1e6) * p.input;
  const extraDocumentCost = (((formBytes + rubricBytes) / 1024) * 80 / 1e6) * p.input;
  const photoCost = ((photoCount || 0) * 1500 / 1e6) * p.input;
  return {
    lo: baseLow + capCost + extraDocumentCost + photoCost + (6000 / 1e6) * p.output,
    hi: baseHigh + capCost + extraDocumentCost + photoCost + (10000 / 1e6) * p.output,
    totalKB: Math.round((capBytes + photoBytes + formBytes + rubricBytes) / 1024),
  };
}

export function estimateChemResultCost({ preReportBytes, manualBytes, dataBytes, photoBytes, photoCount, modelId }) {
  const p = pricingFor(modelId);
  const baseLow = (6000 / 1e6) * p.cacheRead;
  const baseHigh = (6000 / 1e6) * p.cacheWrite;
  const documentKB = (preReportBytes + manualBytes) / 1024;
  const documentLow = (documentKB * 30 / 1e6) * p.input;
  const documentHigh = (documentKB * 100 / 1e6) * p.input;
  const dataCost = (Math.min(dataBytes / 1024, 30) * 80 / 1e6) * p.input;
  const photoCost = ((photoCount || 0) * 1500 / 1e6) * p.input;
  return {
    lo: baseLow + documentLow + dataCost + photoCost + (8000 / 1e6) * p.output,
    hi: baseHigh + documentHigh + dataCost + photoCost + (13000 / 1e6) * p.output,
    totalKB: Math.round((preReportBytes + manualBytes + dataBytes + photoBytes) / 1024),
  };
}

export function estimateFreeReportCost({ docBytes, photoBytes, photoCount, textChars, modelId }) {
  const p = pricingFor(modelId);
  const baseLow = (6000 / 1e6) * p.cacheRead;
  const baseHigh = (6000 / 1e6) * p.cacheWrite;
  const documentKB = (docBytes || 0) / 1024;
  const documentLow = (documentKB * 30 / 1e6) * p.input;
  const documentHigh = (documentKB * 100 / 1e6) * p.input;
  const promptCost = (((textChars || 0) / 3) / 1e6) * p.input;
  const photoCost = ((photoCount || 0) * 1500 / 1e6) * p.input;
  return {
    lo: baseLow + documentLow + promptCost + photoCost + (6000 / 1e6) * p.output,
    hi: baseHigh + documentHigh + promptCost + photoCost + (12000 / 1e6) * p.output,
    totalKB: Math.round(((docBytes || 0) + (photoBytes || 0)) / 1024),
  };
}

export function costRangeText(estimate, krwLow, krwHigh) {
  return `$${estimate.lo.toFixed(2)} ~ $${estimate.hi.toFixed(2)} (약 ₩${krwLow.toLocaleString()} ~ ₩${krwHigh.toLocaleString()})`;
}

const OUTPUT_TOKENS = {
  "chem-pre": [6000, 10000],
  "chem-result": [8000, 13000],
  "phys-result": [6000, 10000],
  "phys-inquiry": [6000, 11000],
  "math-inquiry": [6000, 11000],
  free: [6000, 12000],
  "reading-log": [1500, 3500],
};

export function estimateGenSeconds(type, modelId, extraInputTokens = 0) {
  const isGpt = /^gpt/i.test(modelId || "");
  const perThousand = /^claude-fable/.test(modelId || "")
    ? 45
    : modelId === "claude-sonnet-5"
      ? 9
      : modelId === "gpt-5.4-mini"
        ? 7
        : modelId === "gpt-5.4"
          ? 12
          : modelId === "gpt-5.5"
            ? 14
            : 16;
  const [lowTokens, highTokens] = OUTPUT_TOKENS[type] || [7000, 11000];
  const base = 25 + (type === "chem-pre" && !isGpt ? 40 : 0);
  const extra = (extraInputTokens / 1000) * (perThousand * .25);
  return {
    lo: Math.round(base + (lowTokens / 1000) * perThousand + extra),
    hi: Math.round(base + (highTokens / 1000) * perThousand + extra),
  };
}

export function formatDuration(seconds) {
  const format = (value) => value < 90 ? `${Math.round(value)}초` : `${Math.round(value / 60)}분`;
  return `약 ${format(seconds.lo)} ~ ${format(seconds.hi)}`;
}
