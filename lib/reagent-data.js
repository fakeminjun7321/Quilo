// PubChem에서 시약의 결정론적 물성(분자식·몰질량)과 best-effort 물성(밀도·녹는점·끓는점)을
// 코드로 직접 조회한다. Claude(web_search)가 환각하기 쉬운 수치를 코드가 검증/보정하기 위함.
//
// - 분자식·몰질량: PUG REST property 엔드포인트 (정확·결정론적)
// - 밀도/녹는점/끓는점: PUG-View Experimental Properties (자유 텍스트 → best-effort 파싱)
// - 모든 호출은 timeout + graceful fallback. 실패 시 null 반환(절대 throw 안 함).
// - 외부 의존성 없이 Node 내장 https 사용 (Render Node 버전 무관).

const https = require("https");

const PUBCHEM_HOST = "pubchem.ncbi.nlm.nih.gov";
const TIMEOUT_MS = Number(process.env.PUBCHEM_TIMEOUT_MS || 8000);
const cache = new Map(); // name(lower) -> reagent data | null

function httpGetJson(path) {
  return new Promise((resolve) => {
    const req = https.get(
      { host: PUBCHEM_HOST, path, headers: { Accept: "application/json" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
  });
}

// PUG-View JSON에서 특정 heading 아래의 String 값들을 모두 수집.
function collectStringsUnderHeading(node, heading, acc) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectStringsUnderHeading(item, heading, acc);
    return;
  }
  if (node.TOCHeading === heading && Array.isArray(node.Information)) {
    for (const info of node.Information) {
      const swm = info?.Value?.StringWithMarkup;
      if (Array.isArray(swm)) {
        for (const s of swm) if (s?.String) acc.push(String(s.String));
      }
      if (info?.Value?.Number && Array.isArray(info.Value.Number)) {
        const unit = info.Value.Unit ? ` ${info.Value.Unit}` : "";
        for (const n of info.Value.Number) acc.push(`${n}${unit}`);
      }
    }
  }
  for (const k of Object.keys(node)) {
    if (k === "Information") continue;
    collectStringsUnderHeading(node[k], heading, acc);
  }
}

// "0.7893 g/cu cm at 20 °C" 같은 후보들 중 가장 쓸만한 1개 선택.
function pickDensity(strings) {
  // 밀도와 무관한 항목(생성엔탈피·융해열·용융염 등) 제거 → 잘못된 값 주입 방지.
  const clean = strings.filter(
    (s) => !/enthalpy|latent|formation|molten|heat of|fusion/i.test(s),
  );
  const prefer = clean.find(
    (s) => /g\/(cu )?cm|g\/mL/i.test(s) && /\b2[05]\b/.test(s),
  );
  const any = clean.find((s) => /g\/(cu )?cm|g\/mL/i.test(s));
  const rel = clean.find((s) => /relative density/i.test(s));
  return prefer || any || rel || null; // 깨끗한 후보 없으면 채우지 않음
}
function pickTemp(strings) {
  const c = strings.find((s) => /-?\d+(\.\d+)?\s*°?\s*C/i.test(s));
  return c || strings[0] || null;
}

async function fetchPhysical(cid) {
  const data = await httpGetJson(
    `/rest/pug_view/data/compound/${cid}/JSON?heading=Density`,
  );
  const out = {};
  if (data) {
    const acc = [];
    collectStringsUnderHeading(data, "Density", acc);
    const d = pickDensity(acc);
    if (d) out.density = d;
  }
  const mpData = await httpGetJson(
    `/rest/pug_view/data/compound/${cid}/JSON?heading=Melting%20Point`,
  );
  if (mpData) {
    const acc = [];
    collectStringsUnderHeading(mpData, "Melting Point", acc);
    const v = pickTemp(acc);
    if (v) out.meltingPoint = v;
  }
  const bpData = await httpGetJson(
    `/rest/pug_view/data/compound/${cid}/JSON?heading=Boiling%20Point`,
  );
  if (bpData) {
    const acc = [];
    collectStringsUnderHeading(bpData, "Boiling Point", acc);
    const v = pickTemp(acc);
    if (v) out.boilingPoint = v;
  }
  return out;
}

// 시약명(영문/일반명) -> { cid, molecularFormula, molarMass, density?, meltingPoint?, boilingPoint? } | null
async function getReagentData(name, { physical = true } = {}) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);

  const enc = encodeURIComponent(key);
  const prop = await httpGetJson(
    `/rest/pug/compound/name/${enc}/property/MolecularFormula,MolecularWeight/JSON`,
  );
  const row = prop?.PropertyTable?.Properties?.[0];
  if (!row || row.CID == null) {
    cache.set(key, null);
    return null;
  }
  const result = {
    cid: row.CID,
    molecularFormula: row.MolecularFormula || null,
    molarMass: row.MolecularWeight != null ? String(row.MolecularWeight) : null,
  };
  if (physical) {
    try {
      Object.assign(result, await fetchPhysical(row.CID));
    } catch {
      /* best-effort */
    }
  }
  cache.set(key, result);
  return result;
}

module.exports = { getReagentData };
