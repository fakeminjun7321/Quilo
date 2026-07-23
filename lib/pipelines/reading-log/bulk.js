// 독서록 대량 생성 (reading-log-bulk)
//
// 입력: 엑셀/CSV(책이름·출판사·작가 행) + 영역·과목·대출여부·기간(일괄 지정).
// 흐름: 엑셀 파싱 → 책 수만큼 기간(예: 3/3~7/2) 순차 분배 → 책마다 reading-log
//       generateReportContent 호출 → 책마다 독서활동 기록지 .hwpx → JSZip 묶음.
// 출력: ZIP (outputKind: "zip" - server.js 의 generateBundle 계약).

const XLSX = require("xlsx");
const JSZip = require("jszip");
const { generateReportContent } = require("./generate");
const { generateHwpx } = require("./hwpx-gen");
const { mergeHwpx } = require("./hwpx-merge");
const { calcCost } = require("../../pricing");

// 성공한 책들의 실제 소비 토큰을 합산 - 크레딧은 '전체 합산 토큰' 기준으로 정산한다.
// (책마다 min-1 올림을 하지 않고 총량으로 한 번만 환산해 과청구를 막는다.)
function sumBookUsage(books, model) {
  const acc = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let any = false;
  for (const b of books) {
    const u = b && b.__usage;
    if (!u) continue;
    any = true;
    acc.input_tokens += Number(u.input_tokens) || 0;
    acc.output_tokens += Number(u.output_tokens) || 0;
    acc.cache_creation_input_tokens += Number(u.cache_creation_input_tokens) || 0;
    acc.cache_read_input_tokens += Number(u.cache_read_input_tokens) || 0;
  }
  if (!any) return { usage: null, cost: null };
  return { usage: acc, cost: calcCost({ usage: acc, model }) };
}

// ── 학교 '독서 활동 기록 제출' 구글폼 (ZIP 동봉 제출 도우미용) ──────────────────
// 이 폼은 구글 로그인 + 파일 업로드 필드가 필수라 서버가 대신 제출할 수 없다.
// 대신 교사별로 텍스트 필드가 전부 미리 채워진 링크를 만들어 ZIP에 동봉한다
// (사용자에게 남는 조작: 합본 파일 첨부 + 제출 클릭). 학기가 바뀌어 폼이 교체되면
// 아래 url/entries 만 갱신하면 된다(entry ID는 폼 페이지의 FB_PUBLIC_LOAD_DATA_).
const READING_FORM = {
  url: "https://docs.google.com/forms/d/e/1FAIpQLSepIznCCKcEHJ6udIRklvHJ8diZIT-15WHCl-xsQh2xuDcFNQ/viewform",
  entries: {
    ack: 366340186, // 안내 숙지(객관식)
    sid: 1793268622, // 학번
    name: 1011569858, // 성명
    area: 785835942, // 학생부 기록 영역(교과 담당 교사/담임 교사)
    subj: 1097889162, // 교과명(교사명)
    books: 1732928976, // 도서명(저자) 나열
  },
  ackValue: "위 안내 사항을 숙지하였습니다.",
};

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[c]);
}

// 교사별 그룹 → 제출 도우미 HTML. groups: [{teacher, isHomeroom, subjectLabel, bookList, filename}]
function buildFormHelperHtml({ groups, studentId, userName }) {
  const E = READING_FORM.entries;
  const cards = groups.map((g) => {
    const areaVal = g.isHomeroom ? "담임 교사" : "교과 담당 교사";
    const subjVal = g.isHomeroom
      ? `담임교사(${g.teacher})`
      : `${g.subjectLabel}(${g.teacher})`;
    const url =
      READING_FORM.url +
      "?usp=pp_url" +
      `&entry.${E.ack}=` + encodeURIComponent(READING_FORM.ackValue) +
      (studentId ? `&entry.${E.sid}=` + encodeURIComponent(studentId) : "") +
      (userName ? `&entry.${E.name}=` + encodeURIComponent(userName) : "") +
      `&entry.${E.area}=` + encodeURIComponent(areaVal) +
      `&entry.${E.subj}=` + encodeURIComponent(subjVal) +
      `&entry.${E.books}=` + encodeURIComponent(g.bookList);
    return (
      `<div class="card"><h2>${escapeHtml(subjVal)} - ${g.count}권</h2>` +
      `<p class="hint">기록 영역: <b class="k">${escapeHtml(areaVal)}</b> · 첨부 파일: <b>${escapeHtml(g.filename)}</b></p>` +
      `<p style="font-size:14px">${escapeHtml(g.bookList)}</p>` +
      `<a class="btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">폼 열기 (미리 채움) →</a></div>`
    );
  });
  return `<!doctype html><meta charset="utf-8"><title>독서록 구글폼 제출 도우미</title>
<style>body{font-family:-apple-system,"Malgun Gothic",sans-serif;max-width:860px;margin:40px auto;padding:0 16px;line-height:1.6}
.card{border:1px solid #ddd;border-radius:12px;padding:18px 20px;margin:14px 0}
.btn{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600}
.hint{color:#666;font-size:13px} b.k{color:#2563eb} ol{padding-left:20px}</style>
<h1>📚 독서 활동 기록 - 구글폼 제출 도우미${studentId || userName ? ` (${escapeHtml(studentId)} ${escapeHtml(userName)})` : ""}</h1>
<p>교사 기준 <b>${cards.length}회</b> 제출. 버튼을 누르면 학번·성명·기록영역·교과명·도서 목록이 <b>미리 채워진</b> 폼이 열립니다.</p>
<ol><li>버튼 클릭 → 채워진 값 확인</li><li>이 ZIP 안의 해당 교사 합본 <b>.hwpx 파일 첨부</b> (구글 정책상 파일은 직접 첨부해야 합니다)</li><li>제출 클릭</li></ol>
${cards.join("\n")}
<p class="hint">※ 이번 학기 폼 전용 링크입니다. 도서 목록을 바꿔 다시 생성하면 이 파일도 새로 만들어집니다.</p>`;
}

const MAX_BOOKS = 60; // 한 번에 처리할 최대 권수(과도한 비용·시간 방지)
const GEN_CONCURRENCY = 3; // AI 생성 동시 호출 수(속도/안정 균형)

// ── 엑셀/CSV → [{ bookTitle, publisher, author }] ────────────────────────
function norm(v) {
  return String(v == null ? "" : v).trim();
}
function isBookHeader(s) {
  return /책|도서|제목|title|book/i.test(s);
}
function isPublisherHeader(s) {
  return /출판|publisher/i.test(s);
}
function isAuthorHeader(s) {
  return /작가|저자|지은이|author|writer/i.test(s);
}
function isFieldHeader(s) {
  return /분야|영역|과목|구분|field|category|subject|area/i.test(s);
}
function isTeacherHeader(s) {
  return /교사|선생|담당|teacher/i.test(s);
}
// '교과명/과목명' 열: 양식의 '과목별 독서기록(교과명)' 칸 기입값. '담임(교사)'이면 공통 ○.
function isSubjectNameHeader(s) {
  return /교과명|과목명|담당과목/i.test(s);
}
// '대출' 열: 학교 도서관 대출여부 ○/× 기입값.
function isBorrowHeader(s) {
  return /대출/i.test(s);
}
function normBorrow(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) return "";
  if (/^(○|o|0?는아님|yes|y|예|대출|√|v|true|1)$/i.test(s) || s === "○") return "yes";
  if (/^(×|x|no|n|아니오|아니요|미대출|false)$/i.test(s)) return "no";
  return "";
}

// 엑셀 '분야' 텍스트 → index.html 영역 select 값(generate.js DOMAIN_MAP 키).
const FIELD_DOMAIN_MAP = {
  수학: "major-math",
  물리: "major-physics",
  화학: "major-chemistry",
  생물: "major-biology",
  생명: "major-biology",
  생명과학: "major-biology",
  지구: "major-earth",
  지구과학: "major-earth",
  정보: "major-cs",
  정보과학: "major-cs",
  컴퓨터: "major-cs",
  교양: "general-philosophy",
  철학: "general-philosophy",
  종교: "general-philosophy",
  "교양·철학·종교": "general-philosophy",
  사회: "general-social",
  사회과학: "general-social",
  "과학·예술·언어": "general-science-art",
  예술: "general-science-art",
  언어: "general-science-art",
  문학: "general-literature",
  역사: "general-history",
  고전: "general-classics",
};
// 분야 문자열 → 영역 코드. 정확 일치 우선, 없으면 부분 포함으로 추정. 모르면 "".
function fieldToDomain(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (FIELD_DOMAIN_MAP[s]) return FIELD_DOMAIN_MAP[s];
  const compact = s.replace(/\s|·|\/|,/g, "");
  for (const [k, v] of Object.entries(FIELD_DOMAIN_MAP)) {
    const kc = k.replace(/\s|·|\/|,/g, "");
    if (compact.includes(kc) || kc.includes(compact)) return v;
  }
  return "";
}

function parseBooks(buffer, ext) {
  let wb;
  try {
    wb =
      ext === "csv"
        ? XLSX.read(buffer.toString("utf8"), { type: "string" })
        : XLSX.read(buffer, { type: "buffer" });
  } catch (e) {
    throw new Error(`엑셀/CSV 파싱 실패: ${e.message}`);
  }
  const sheetName = (wb.SheetNames || [])[0];
  if (!sheetName) throw new Error("엑셀에 시트가 없습니다.");
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
  });
  if (!rows.length) throw new Error("엑셀이 비어 있습니다.");

  // 헤더 행 탐지: 책/출판/작가(+분야) 키워드가 보이면 그 행을 헤더로, 열 인덱스 매핑.
  let fieldCol = -1,
    bookCol = 0,
    pubCol = 1,
    authCol = 2,
    teacherCol = -1,
    subjectNameCol = -1,
    borrowCol = -1,
    dataStart = 0;
  const head = rows[0].map(norm);
  const headerLooks =
    head.some(isBookHeader) ||
    head.some(isPublisherHeader) ||
    head.some(isAuthorHeader) ||
    head.some(isFieldHeader);
  if (headerLooks) {
    const findCol = (pred, fallback) => {
      const i = head.findIndex((c) => pred(c));
      return i >= 0 ? i : fallback;
    };
    fieldCol = findCol(isFieldHeader, -1);
    bookCol = findCol(isBookHeader, fieldCol >= 0 ? 1 : 0);
    // 출판사 헤더가 없으면 -1(빈 출판사) - bookCol+1 로 밀면 [분야,책,저자]에서 저자 열을
    // 출판사로 잘못 읽는다. 헤더가 있을 때만 그 열을 쓴다.
    pubCol = findCol(isPublisherHeader, -1);
    authCol = findCol(isAuthorHeader, bookCol + 2);
    // 출판사 헤더가 없어 pubCol 이 저자 열과 겹치면 출판사를 비운다(저자를 출판사로 출력 방지).
    if (pubCol >= 0 && pubCol === authCol) pubCol = -1;
    teacherCol = findCol(isTeacherHeader, -1);
    subjectNameCol = findCol(isSubjectNameHeader, -1);
    borrowCol = findCol(isBorrowHeader, -1);
    // '교사명' 헤더가 '교과명'보다 앞에 있으면 teacher 판정이 교과명 열을 먹을 수 있으니,
    // 두 열이 같은 인덱스로 잡히면 teacher 를 다음 매칭으로 재탐색한다.
    if (teacherCol >= 0 && teacherCol === subjectNameCol) {
      const again = head.findIndex((c, i) => i !== subjectNameCol && isTeacherHeader(c));
      teacherCol = again;
    }
    dataStart = 1;
  } else if (
    (rows[0] || []).length >= 4 &&
    fieldToDomain(norm((rows[0] || [])[0])) &&
    !fieldToDomain(norm((rows[0] || [])[1]))
  ) {
    // 머리글 없이 [분야, 책이름, 출판사, 작가] 형태로 보이면 한 칸씩 밀어서 인식.
    fieldCol = 0;
    bookCol = 1;
    pubCol = 2;
    authCol = 3;
  }

  const books = [];
  for (let r = dataStart; r < rows.length; r++) {
    const row = rows[r] || [];
    const bookTitle = norm(row[bookCol]).slice(0, 200);
    if (!bookTitle) continue; // 책 제목 없는 행은 건너뜀
    const field = fieldCol >= 0 ? norm(row[fieldCol]).slice(0, 40) : "";
    books.push({
      bookTitle,
      publisher: pubCol >= 0 ? norm(row[pubCol]).slice(0, 200) : "",
      author: norm(row[authCol]).slice(0, 200),
      field, // 엑셀 '분야' 원문 (있으면)
      fieldDomain: fieldToDomain(field), // 영역 코드로 매핑 (모르면 "")
      // '교사' 열(있으면): 구글폼 '교사 기준 하나의 파일 제출'용 합본 그룹 키.
      teacher: teacherCol >= 0 ? norm(row[teacherCol]).slice(0, 40) : "",
      // '교과명' 열(있으면): 양식 '과목별 독서기록(교과명)' 칸. '담임'이면 공통 ○ 처리.
      subjectName: subjectNameCol >= 0 ? norm(row[subjectNameCol]).slice(0, 40) : "",
      // '대출' 열(있으면): ○/× → yes/no (빈칸이면 폼 일괄값 사용).
      borrowed: borrowCol >= 0 ? normBorrow(row[borrowCol]) : "",
    });
    if (books.length >= MAX_BOOKS) break;
  }
  if (!books.length) {
    throw new Error(
      "엑셀에서 책을 찾지 못했습니다. 첫 열에 책 이름이 있는지 확인하세요(책이름·출판사·작가 순).",
    );
  }
  return books;
}

// ── 기간(YYYY-MM-DD ~ YYYY-MM-DD)을 n권에 순차·비중복 분배 ──────────────
function pad(n) {
  return String(n).padStart(2, "0");
}
function toISO(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function parseISO(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}
function splitPeriod(startISO, endISO, n) {
  const start = parseISO(startISO);
  const end = parseISO(endISO);
  const DAY = 86400000;
  if (start == null || end == null || end < start || n <= 0) {
    // 분배 불가 시 전부 빈 날짜(양식에 일시 미기재).
    return Array.from({ length: Math.max(0, n) }, () => ({ start: "", end: "" }));
  }
  const totalDays = Math.floor((end - start) / DAY) + 1; // 포함 일수
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = start + Math.floor((i * totalDays) / n) * DAY;
    // 다음 구간 시작 하루 전까지(마지막 권은 end 까지) - 비중복 연속 구간.
    const nextStart = start + Math.floor(((i + 1) * totalDays) / n) * DAY;
    let e = nextStart - DAY;
    if (e < s) e = s; // 구간이 1일 미만이면 같은 날
    if (i === n - 1) e = end;
    out.push({ start: toISO(new Date(s)), end: toISO(new Date(e)) });
  }
  return out;
}

// 동시성 제한 map (순서 보존).
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

function safeName(s) {
  return String(s || "독서록")
    .replace(/[\\/:*?"<>|\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// ── generateContent (대량) - server.js runGeneration 이 호출 ─────────────
async function generateReadingLogBulk(input) {
  const {
    books = [],
    domain = "",
    recordArea = "auto",
    subject = "",
    enrolledSubjects = "",
    subjectTeachers = "", // 웹폼 입력 '과목-교사' 매핑(줄바꿈 구분)
    homeroomTeacher = "", // 매핑에 없는 과목 책들의 담임교사 이름
    borrowed = "no",
    periodStart = "",
    periodEnd = "",
    fontFace,
    model = null,
    signal,
    onProgress = () => {},
  } = input;

  if (!books.length) throw new Error("처리할 책이 없습니다.");
  const intervals = splitPeriod(periodStart, periodEnd, books.length);

  // ── '과목-담당교사' 매핑(웹폼 입력) ─────────────────────────────────────────
  // 한 줄에 '과목-교사'. 책의 영역(또는 엑셀 교과명)이 매핑과 일치하면 그 과목·교사로
  // 과목별 독서기록(교과명)에 기입하고, 매핑에 없는 과목의 책은 전부 담임교사 소속으로
  // 공통 독서기록(○) 처리한다. (매핑·담임을 아예 입력하지 않으면 기존 동작 유지)
  const subjMap = [];
  String(subjectTeachers || "")
    .split(/\n+/)
    .forEach((line) => {
      // 구분자로 하이픈·엔대시(U+2013)·엠대시(U+2014)·콜론 허용(사용자 입력 매칭용).
      const m = String(line).trim().match(/^(.+?)\s*[-\u2013\u2014:]\s*(.+)$/);
      if (m) {
        subjMap.push({
          subject: m[1].trim().slice(0, 40),
          teacher: m[2].trim().slice(0, 40),
        });
      }
    });
  const useMapping = subjMap.length > 0 || !!String(homeroomTeacher || "").trim();
  const normKey = (s) => String(s || "").replace(/\s|·|\/|,/g, "").toLowerCase();
  const findMap = (label) => {
    const k = normKey(label);
    if (!k) return null;
    return (
      subjMap.find((m) => {
        const mk = normKey(m.subject);
        return mk === k || mk.includes(k) || k.includes(mk);
      }) || null
    );
  };
  if (useMapping) {
    onProgress(
      `🧭 과목-담당교사 매핑 ${subjMap.length}건 · 미매핑 과목은 담임(${String(homeroomTeacher || "").trim() || "미지정"}) 공통 ○ 처리`,
    );
  }

  // 대량 생성 균질화 방지: 책마다 선택 계기 유형을 회전 주입(모델이 부자연스러우면 무시 가능).
  // 단일 프롬프트로 수십 권을 돌릴 때 계기 서사가 복제되는 것을 막는다.
  // ⚠ '진행 중인 탐구·R&E' 유형 금지(활동 날조 유발 이력) + 극적 서사 금지(2026-07-03
  //   사용자 지시: 계기는 뻔하고 무난하게). 검증 부담 없는 평범한 유형만 회전한다.
  const REASON_SEEDS = [
    "그 분야에 평소 관심이 있어서",
    "수업에서 배운 주제와 관련이 있어서",
    "선생님이나 친구의 추천으로",
    "제목과 목차를 보고 궁금해져서",
    "널리 알려진 책이라 읽어 보고 싶어서",
    "진로와 관련이 있어 보여서",
  ];

  onProgress(`📚 총 ${books.length}권 독서록 생성 시작 (모델: ${model || "기본"})`);
  let done = 0;
  const failures = []; // 책별 실패 기록 - { bookTitle, error }. 한 권 실패가 전체를 버리지 않게.
  const contents = await mapLimit(books, GEN_CONCURRENCY, async (b, i) => {
    if (signal?.aborted) throw new Error("생성이 중단되었습니다.");
    // 책별 학생부 기록영역 확정 - 우선순위: ① 웹폼 '과목-교사' 매핑 ② 엑셀 '교과명' 열.
    // 과목 매칭 → 과목별 독서기록(교과명 기입), 담임/미매핑 → 공통 독서기록(○).
    let subjName = String(b.subjectName || "").trim();
    let bookTeacher = String(b.teacher || "").trim();
    let isHomeroom = /담임/.test(subjName);
    if (useMapping) {
      const hit = findMap(subjName) || findMap(b.field);
      if (hit) {
        subjName = hit.subject;
        bookTeacher = hit.teacher;
        isHomeroom = false;
      } else {
        subjName = "담임교사";
        bookTeacher = String(homeroomTeacher || "").trim() || bookTeacher || "담임교사";
        isHomeroom = true;
      }
    }
    try {
      const c = await generateReportContent({
        bookTitle: b.bookTitle,
        author: b.author,
        publisher: b.publisher,
        recordArea: subjName ? (isHomeroom ? "common" : "subject") : recordArea,
        subject: subjName && !isHomeroom ? subjName : subject,
        enrolledSubjects,
        // 엑셀 '분야' 열이 있으면 책마다 그 영역을, 없으면 폼에서 일괄 지정한 영역을 사용.
        domain: b.fieldDomain || domain,
        borrowed: b.borrowed || borrowed, // 엑셀 '대출' 열 우선, 없으면 폼 일괄값
        startDate: intervals[i].start,
        endDate: intervals[i].end,
        reasonSeed: REASON_SEEDS[i % REASON_SEEDS.length],
        fontFace,
        model,
        signal,
        // 개별 책 진행로그는 과도하니 콘텐츠 단계에선 조용히.
        onProgress: () => {},
      });
      done += 1;
      onProgress(`📖 (${done}/${books.length}) ${b.bookTitle} 작성 완료`);
      c.__teacher = bookTeacher; // 교사별 합본 그룹 키(generateBundle에서 사용)
      c.__subjectName = isHomeroom ? "담임교사" : subjName; // 합본 파일명용(예: 물리(박홍).hwpx)
      return c;
    } catch (e) {
      // 진짜 중단(AbortSignal)이면 전체를 멈춘다.
      if (signal?.aborted) throw e;
      // 한 권 실패(3회 빈 응답·529·타임아웃 등)는 기록만 하고 나머지는 계속 진행.
      failures.push({ bookTitle: b.bookTitle, error: String((e && e.message) || e) });
      onProgress(
        `⚠️ 「${b.bookTitle}」 생성 실패 - 건너뜀 (${failures.length}권 실패): ${String((e && e.message) || e)}`,
      );
      return null; // 실패 자리표시자 - 아래에서 걸러낸다.
    }
  });

  // 실패한 책(null)은 제외하고 성공분만 묶는다. 한 권도 못 만들면 그때만 실패 처리.
  const ok = contents.filter(Boolean);
  if (!ok.length) {
    throw new Error(
      `독서록을 한 권도 생성하지 못했습니다 (${failures.length}권 모두 실패).` +
        (failures[0] ? ` 첫 오류: ${failures[0].error}` : ""),
    );
  }
  if (failures.length) {
    onProgress(
      `⚠️ 총 ${failures.length}권 생성 실패 - 성공한 ${ok.length}권만 묶습니다: ${failures
        .map((f) => f.bookTitle)
        .join(", ")}`,
    );
  }

  // 성공한 책들의 실제 소비 토큰 합산 - 서버가 이 값으로 크레딧을 정산한다(예약 최악치 → 실제).
  const { usage: totalUsage, cost: totalCost } = sumBookUsage(ok, model);
  return {
    __isBulk: true,
    __fontFace: fontFace,
    books: ok,
    __failures: failures,
    __usage: totalUsage,
    __cost: totalCost,
  };
}

// ── generateBundle - 책마다 .hwpx → ZIP (outputKind: "zip") ──────────────
async function generateBundle(content, ctx = {}) {
  const { studentId = "", userName = "", signal, onProgress = () => {} } = ctx;
  const books = Array.isArray(content && content.books) ? content.books : [];
  if (!books.length) throw new Error("묶을 독서록이 없습니다.");

  // 파일명 규칙: 학번이름_도서명.hwpx (예: 2402구민준_코스모스.hwpx).
  const who = safeName(`${studentId}${userName}`);
  const usedNames = new Set();
  const zip = new JSZip();
  const bufs = []; // 교사별 합본 병합용으로 개별 hwpx 버퍼 보관
  for (let i = 0; i < books.length; i++) {
    if (signal?.aborted) throw new Error("생성이 중단되었습니다.");
    const bookContent = {
      ...books[i],
      student_id: studentId,
      student_name: userName,
      __fontFace: books[i].__fontFace || content.__fontFace,
      __style: "default",
    };
    onProgress(
      `📦 (${i + 1}/${books.length}) 「${bookContent.book_title || ""}」 양식 채우는 중…`,
    );
    bufs[i] = await generateHwpx(bookContent, { signal });
  }

  // ── 교사별 합본 (구글폼 '교과 담당 교사 기준 하나의 파일 제출' 요건) ──────────
  // 엑셀에 '교사' 열이 있으면 ZIP 은 선생님별 합본 파일로만 구성한다
  // (같은 교사의 기록지들을 멀티섹션 hwpx 하나로 병합 - 책마다 새 페이지).
  // 그룹 키 = 과목라벨|교사 - 같은 선생님이 과목 담당과 담임을 겸해도(예: 수학·담임이
  // 모두 추철우) '수학(추철우)'와 '담임교사(추철우)'가 별도 합본·별도 폼 제출로 나뉜다.
  const byTeacher = new Map();
  for (let i = 0; i < books.length; i++) {
    const t = String(books[i].__teacher || "").trim();
    if (!t) continue;
    const label = String(books[i].__subjectName || "").trim();
    const key = `${label}|${t}`;
    if (!byTeacher.has(key)) byTeacher.set(key, { teacher: t, idxs: [] });
    byTeacher.get(key).idxs.push(i);
  }

  const addUnique = (base) => {
    let fname = `${base}.hwpx`;
    let dup = 2;
    while (usedNames.has(fname)) fname = `${base} (${dup++}).hwpx`;
    usedNames.add(fname);
    return fname;
  };

  if (byTeacher.size) {
    const helperGroups = []; // 구글폼 제출 도우미 HTML용
    for (const [, grp] of byTeacher) {
      const teacher = grp.teacher;
      const idxs = grp.idxs;
      if (signal?.aborted) throw new Error("생성이 중단되었습니다.");
      const subjLabel = String(books[idxs[0]].__subjectName || "").trim();
      const isHomeroom = /담임/.test(subjLabel);
      const bookList = idxs
        .map((i) => {
          const t = String(books[i].book_title || "").trim();
          const a = String(books[i].author || "").trim();
          return a ? `${t}(${a})` : t;
        })
        .join(", ");
      try {
        onProgress(`🧷 ${teacher} 선생님 제출용 합본 병합 중… (${idxs.length}권)`);
        const merged = await mergeHwpx(idxs.map((i) => bufs[i]), { signal });
        // 파일명: 학번이름_책이름(작가) 나열.hwpx (폼 규칙 'Ex. 1101 홍길동_ 통계의 미학').
        // macOS 파일명 255바이트 한도 - 한도 내에서 나열하고 넘치면 ' 외 N권'으로 축약.
        const titles = idxs
          .map((i) => {
            const t = safeName(String(books[i].book_title || "").trim());
            const a = safeName(String(books[i].author || "").trim());
            return t ? (a ? `${t}(${a})` : t) : "";
          })
          .filter(Boolean);
        const prefix = who ? `${who}_` : "";
        const MAX_BYTES = 180; // '.hwpx'·중복 번호 여유 포함 안전선
        let list = "";
        for (let k = 0; k < titles.length; k++) {
          const piece = (list ? ", " : "") + titles[k];
          if (Buffer.byteLength(prefix + list + piece, "utf8") > MAX_BYTES) {
            list = list
              ? `${list} 외 ${titles.length - k}권`
              : `${titles[0].slice(0, 40)} 외 ${titles.length - 1}권`;
            break;
          }
          list += piece;
        }
        const fname = addUnique(`${prefix}${list || "독서록"}`);
        zip.file(fname, merged);
        helperGroups.push({
          teacher,
          isHomeroom,
          subjectLabel: subjLabel || label,
          bookList,
          count: idxs.length,
          filename: fname,
        });
      } catch (e) {
        // 합본 실패 시 그 교사 책들은 개별 파일로 폴백해 담는다(제출은 가능하게).
        onProgress(`⚠ ${teacher} 합본 병합 실패 → 개별 파일로 대체: ${e.message}`);
        for (const i of idxs) {
          const t = safeName(books[i].book_title || `독서록${i + 1}`);
          zip.file(addUnique(who ? `${who}_${t}` : t), bufs[i]);
        }
        helperGroups.push({
          teacher,
          isHomeroom,
          subjectLabel: subjLabel || "독서록",
          bookList,
          count: idxs.length,
          filename: "(개별 파일들 - 병합 실패)",
        });
      }
    }
    // 구글폼 제출 도우미 동봉: 텍스트 필드 전부 미리 채운 링크(파일 첨부·제출만 남음).
    try {
      onProgress("🔗 구글폼 제출 도우미(구글폼_제출.html) 생성");
      zip.file(
        "구글폼_제출.html",
        buildFormHelperHtml({
          groups: helperGroups,
          studentId: String(studentId || "").trim(),
          userName: String(userName || "").trim(),
        }),
      );
    } catch (e) {
      onProgress(`⚠ 제출 도우미 생성 실패(합본은 정상): ${e.message}`);
    }
    // 교사 열이 없는 행이 섞여 있으면 그 책들만 개별 파일로.
    for (let i = 0; i < books.length; i++) {
      if (String(books[i].__teacher || "").trim()) continue;
      const t = safeName(books[i].book_title || `독서록${i + 1}`);
      zip.file(addUnique(who ? `${who}_${t}` : t), bufs[i]);
    }
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return {
      buffer,
      filename: `독서활동기록지_교사별${byTeacher.size}건_${books.length}권.zip`,
    };
  }

  // 교사 열이 없으면 기존대로 책마다 개별 파일.
  for (let i = 0; i < books.length; i++) {
    const titlePart = safeName(books[i].book_title || `독서록${i + 1}`);
    zip.file(addUnique(who ? `${who}_${titlePart}` : titlePart), bufs[i]);
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  return { buffer, filename: `독서활동기록지_${books.length}권.zip` };
}

module.exports = {
  parseBooks,
  splitPeriod,
  generateReadingLogBulk,
  generateBundle,
};
