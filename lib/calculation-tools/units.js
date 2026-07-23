"use strict";

const LINEAR = {
  length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, um: 1e-6, nm: 1e-9, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 },
  mass: { kg: 1, g: 1e-3, mg: 1e-6, ug: 1e-9, lb: 0.45359237, oz: 0.028349523125 },
  time: { s: 1, ms: 1e-3, us: 1e-6, min: 60, h: 3600, day: 86400 },
  pressure: { pa: 1, kpa: 1e3, mpa: 1e6, bar: 1e5, atm: 101325, torr: 101325 / 760, psi: 6894.757293168 },
  energy: { j: 1, kj: 1e3, mj: 1e6, cal: 4.184, kcal: 4184, wh: 3600, kwh: 3.6e6, ev: 1.602176634e-19 },
  volume: { m3: 1, l: 1e-3, ml: 1e-6, cm3: 1e-6, gal_us: 0.003785411784 },
  angle: { rad: 1, deg: Math.PI / 180, grad: Math.PI / 200 },
  speed: { "m/s": 1, "km/h": 1 / 3.6, mph: 0.44704, knot: 0.514444444444 },
};

function temperatureToKelvin(value, unit) {
  if (unit === "k") return value;
  if (unit === "c") return value + 273.15;
  if (unit === "f") return (value - 32) * 5 / 9 + 273.15;
  throw new Error(`지원하지 않는 온도 단위입니다: ${unit}`);
}

function kelvinToTemperature(value, unit) {
  if (unit === "k") return value;
  if (unit === "c") return value - 273.15;
  if (unit === "f") return (value - 273.15) * 9 / 5 + 32;
  throw new Error(`지원하지 않는 온도 단위입니다: ${unit}`);
}

function convertUnit(value, from, to, category) {
  const input = Number(value);
  if (!Number.isFinite(input)) throw new Error("유효한 변환 값이 필요합니다.");
  const source = String(from || "").trim().toLowerCase().replace("μ", "u");
  const target = String(to || "").trim().toLowerCase().replace("μ", "u");
  const kind = String(category || "").trim().toLowerCase();
  if (kind === "temperature") {
    const kelvin = temperatureToKelvin(input, source);
    if (kelvin < 0) throw new Error("절대온도는 0 K보다 작을 수 없습니다.");
    const result = kelvinToTemperature(kelvin, target);
    return { value: input, from: source, to: target, category: kind, result };
  }
  const units = LINEAR[kind];
  if (!units) throw new Error(`지원하지 않는 단위 범주입니다: ${kind}`);
  if (!(source in units) || !(target in units)) throw new Error(`${kind} 범주에서 지원하지 않는 단위입니다.`);
  return { value: input, from: source, to: target, category: kind, result: input * units[source] / units[target] };
}

function unitCatalog() {
  return {
    ...Object.fromEntries(Object.entries(LINEAR).map(([category, units]) => [category, Object.keys(units)])),
    temperature: ["c", "f", "k"],
  };
}

module.exports = { convertUnit, unitCatalog };
