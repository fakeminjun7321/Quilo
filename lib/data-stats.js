// 업로드된 엑셀/CSV의 숫자 열에 대해 기술통계(n·평균·표준편차·최소·최대)를 코드로 계산한다.
// LLM은 산수가 불안정하므로, 평균·표준편차는 코드가 계산해 "정확한 값"으로 프롬프트에 주입한다.
// parseToTables() 결과({ sheetName, headers, rows: string[][] })를 입력으로 받는다.

const INDEX_HEADER = /^(회차|시행|trial|no\.?|번호|index|순번|#)$/i;

function toNumber(raw) {
  const s = String(raw == null ? "" : raw)
    .replace(/,/g, "")
    .replace(/[%℃°]/g, "")
    .trim();
  if (s === "") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function computeColumnStats(headers, rows) {
  const out = [];
  const nCols = Math.max(
    headers.length,
    ...rows.map((r) => (Array.isArray(r) ? r.length : 0)),
    0,
  );
  for (let c = 0; c < nCols; c++) {
    const header = String(headers[c] || "").trim();
    if (INDEX_HEADER.test(header)) continue; // 회차/번호 같은 인덱스 열 제외
    let nonEmpty = 0;
    const nums = [];
    for (const row of rows) {
      const cell = row[c];
      if (String(cell == null ? "" : cell).trim() !== "") nonEmpty++;
      const v = toNumber(cell);
      if (v !== null) nums.push(v);
    }
    // 값이 2개 이상이고, 채워진 칸의 60% 이상이 숫자인 열만 통계 산출
    if (nums.length < 2 || nums.length < nonEmpty * 0.6) continue;
    const n = nums.length;
    const mean = nums.reduce((a, b) => a + b, 0) / n;
    const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    out.push({
      column: header || `열${c + 1}`,
      n,
      mean,
      sd: Math.sqrt(variance),
      min: Math.min(...nums),
      max: Math.max(...nums),
    });
  }
  return out;
}

function fmt(x) {
  if (!Number.isFinite(x)) return "-";
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return x.toExponential(4);
  return Number(x.toFixed(6)).toString();
}

// 여러 시트 표 → 프롬프트용 통계 블록 (없으면 빈 문자열)
function buildStatsDigest(tables) {
  const blocks = [];
  for (const t of tables || []) {
    const stats = computeColumnStats(t.headers || [], t.rows || []);
    if (!stats.length) continue;
    const lines = [
      `[시트: ${t.sheetName || "(이름없음)"}]`,
      "| 열 | n | 평균 | 표준편차(표본) | 최소 | 최대 |",
      "|---|---:|---:|---:|---:|---:|",
    ];
    for (const s of stats) {
      lines.push(
        `| ${s.column} | ${s.n} | ${fmt(s.mean)} | ${fmt(s.sd)} | ${fmt(s.min)} | ${fmt(s.max)} |`,
      );
    }
    blocks.push(lines.join("\n"));
  }
  if (!blocks.length) return "";
  return [
    "=== 코드 계산 통계값 (정확 — 그대로 사용) ===",
    "아래 평균·표준편차는 업로드된 엑셀/CSV 원본에서 서버가 직접 계산한 값입니다.",
    "보고서의 평균·표준편차는 재계산하지 말고 이 값을 그대로 쓰세요. 백분율 오차 등은 이 평균을 기준으로 계산하세요.",
    "표에 없는 열·값은 만들지 마세요.",
    "",
    ...blocks,
    "=== 계산 통계값 끝 ===",
  ].join("\n");
}

module.exports = { computeColumnStats, buildStatsDigest };
