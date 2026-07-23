"use strict";

(function initQuiloSiteShell() {
  // 보고서 메모·학번·코드·채팅은 계정과 무관한 브라우저 전역 저장소에 남으면
  // 공용 기기에서 다음 로그인 사용자에게 노출될 수 있다. 현재 principal을 표시하고
  // 계정 전환·로그아웃 때 민감한 키만 지운다(테마 같은 기기 설정은 유지).
  const storagePrivacy = window.QuiloStoragePrivacy || (() => {
    const PRINCIPAL_KEY = "quilo.browser.principal.v1";
    const LOCAL_EXACT = new Set([
      "studentId",
      "quiloStyleNote",
      "chemPreUserDefaults",
      "quilo_studio_session_v1",
      "ceFiles",
      "ceCode",
      "ceActive",
      "lastReportPrefs",
      "lastUsername",
      "codingSolved",
      "quilo.editorial.bookmarks.v1",
      "quilo.googleDrive.autoSaveReports",
      "quilo.googleDrive.folderId",
    ]);
    const LOCAL_PREFIXES = [
      "quiloDraft:v1:",
      "quilo.editorial.draft.v2.",
      "codingCode:",
    ];
    const SESSION_EXACT = new Set([
      "quiloChat",
      "quiloChat:v2",
      "quilo_vibe_handoff",
      "pendingReportType",
    ]);

    function removeMatching(storage, exact, prefixes = []) {
      if (!storage) return;
      const keys = [];
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key && (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix)))) {
            keys.push(key);
          }
        }
        keys.forEach((key) => storage.removeItem(key));
      } catch (_) {}
    }

    function clear() {
      removeMatching(window.localStorage, LOCAL_EXACT, LOCAL_PREFIXES);
      removeMatching(window.sessionStorage, SESSION_EXACT);
    }

    function protect(principalId) {
      const next = String(principalId || "").trim();
      if (!next) return false;
      try {
        const previous = localStorage.getItem(PRINCIPAL_KEY);
        // marker가 없는 첫 배포/첫 로그인도 기존 전역 초안을 안전하게 정리한다.
        if (previous !== next) clear();
        localStorage.setItem(PRINCIPAL_KEY, next);
        return true;
      } catch (_) {
        clear();
        return false;
      }
    }

    function signOut() {
      clear();
      try { localStorage.removeItem(PRINCIPAL_KEY); } catch (_) {}
    }

    return Object.freeze({ clear, protect, signOut });
  })();
  window.QuiloStoragePrivacy = storagePrivacy;

  const header = document.querySelector("[data-ui-shell]");
  if (!header) return;

  const FALLBACK_FEATURES = Object.freeze([
    ["chem-pre", "화학 사전보고서", "실험 매뉴얼에서 사전보고서 초안을 만듭니다.", "/?report=chem-pre", "member", "active"],
    ["chem-result", "화학 결과보고서", "데이터와 사진으로 결과와 분석을 작성합니다.", "/?report=chem-result", "member", "active"],
    ["phys-result", "물리 결과보고서", "Capstone과 엑셀을 표와 그래프로 정리합니다.", "/?report=phys-result", "member", "active"],
    ["free", "자유 보고서", "지시와 자료를 원하는 문서 형식으로 정리합니다.", "/?report=free", "member", "active"],
    ["reading-log", "독서활동 기록지", "도서 정보를 학교 독서록 양식으로 작성합니다.", "/?report=reading-log", "member", "active"],
    ["reading-log-bulk", "독서록 대량 생성", "여러 독서록을 만들고 ZIP으로 묶습니다.", "/?report=reading-log-bulk", "member", "active"],
    ["problem-set", "문제집 메이커", "교재에서 문제지와 해설지 세트를 만듭니다.", "/?report=problem-set", "pro", "pro"],
    ["vocabulary-book", "단어장 메이커", "영어교재·기존 단어장·엑셀표에서 영한 단어장을 만듭니다.", "/?report=vocabulary-book", "pro", "pro"],
    ["form-maker", "양식 메이커", "설명이나 사진에서 편집 가능한 양식을 만듭니다.", "/?report=form-maker", "pro", "pro"],
    ["print-pdf-restore", "프린트 PDF 복원", "종이 사진을 의미가 보존된 벡터 PDF로 복원하고 300dpi로 검증합니다.", "/?report=print-pdf-restore", "admin", "beta"],
    ["physics-studio", "고급 물리 문제 스튜디오", "심화 물리 문제와 풀이를 생성합니다.", "/physics-studio.html", "pro", "pro"],
    ["coding-test", "코딩 수행평가 대비", "브라우저 채점과 튜터로 코딩을 연습합니다.", "/exam-prep.html", "pro", "pro"],
    ["relativity-study", "상대론 학습", "민코프스키 평면으로 상대론을 학습합니다.", "/study.html", "pro", "pro"],
    ["create", "창작 스튜디오", "대화형 미리보기로 웹 결과물을 만듭니다.", "/create.html", "pro", "pro"],
    ["vibe-coding", "바이브 코딩 생성기", "아이디어에서 프로젝트 구조를 설계합니다.", "/vibe-coding.html", "pro", "pro"],
    ["quilo-code", "Quilo Code", "코드를 생성하고 수정하며 미리 봅니다.", "/editor.html", "pro", "pro"],
    ["file-chat", "파일 챗봇", "업로드한 파일을 바탕으로 대화합니다.", "/filechat.html", "pro", "pro"],
    ["quilo-schedule", "Quilo schedule", "등록된 2학년 4반 구성원의 시간표와 일정을 확인합니다.", "/schedule/", "member", "active"],
    ["pdf-translate", "PDF 통번역", "문서 구조를 지키며 번역하고 재조판합니다.", "/translate.html", "max", "max"],
    ["cap-translate", "Capstone 번역", "측정 구조를 보존해 Capstone 파일을 번역합니다.", "/?report=cap-translate", "pro", "pro"],
    ["file-convert", "파일 및 PDF 도구", "파일, 이미지, PDF를 브라우저에서 처리합니다.", "/tools/index.html", "public", "active"],
    ["equation", "LaTeX 한글 수식", "공개 가능한 독립 구현 기여를 기다리고 있습니다.", "/equation/index.html", "public", "paused"],
    ["image-ocr", "이미지 OCR", "4중 교차 검증 후 보기·병합 표·그림을 Word·한글·HTML·TXT로 복원합니다.", "/tools/image-ocr.html", "pro", "pro"],
    ["pdf-analysis", "PDF 분석", "페이지와 텍스트층, 수식 밀도를 분석합니다.", "/tools/pdf-analysis.html", "member", "active"],
  ].map(([id, title, summary, path, audience, status]) => ({ id, title, summary, path, audience, status })));

  const STATIC_LINKS = Object.freeze({
    developer: [
      { title: "빠른 시작", summary: "계정 연결부터 첫 요청까지 확인합니다.", path: "/developers.html#quickstart" },
      { title: "API 문서", summary: "인증과 실제 엔드포인트를 확인합니다.", path: "/developers.html#api" },
      { title: "액세스 토큰", summary: "필요한 권한만 선택해 토큰을 발급합니다.", path: "/developers.html#tokenCard", audience: "member" },
      { title: "기능 카탈로그", summary: "연결 가능한 전체 기능을 검색합니다.", path: "/developers.html#catalog" },
    ],
    resources: [
      { title: "이용 가이드", summary: "기능별 입력 방법과 사용 원칙", path: "/guide.html" },
      { title: "개발 노트", summary: "Quilo 활용 팁과 개발 기록", path: "/developer-notes.html" },
      { title: "자료실", summary: "스탭이 정리한 학습·실험 자료", path: "/resources.html" },
      { title: "예시", summary: "Quilo로 만든 실제 결과물", path: "/examples.html" },
      { title: "업데이트", summary: "새 기능과 개선 내역", path: "/changelog.html" },
      { title: "커뮤니티", summary: "질문, 사용 팁, 작업 사례 공유", path: "/community.html" },
      { title: "고객센터", summary: "문의 접수와 자주 묻는 질문", path: "/support.html" },
      { title: "학교 도입", summary: "기관용 도입 문의", path: "/school-apply.html" },
    ],
    apps: [
      { title: "Quilo Desktop", summary: "macOS와 Windows용 작업 공간", path: "/apps/quilo.html" },
      { title: "Live Translator", summary: "로컬 실시간 음성 번역 앱", path: "/apps/live-translator.html" },
    ],
  });

  const SEARCH_ALIASES = Object.freeze({
    "chem-pre": ["화학 예비보고서", "화학 레포트", "사전 레포트", "pre lab"],
    "chem-result": ["화학 실험보고서", "화학 레포트", "결과 레포트", "post lab"],
    "phys-result": ["물리 실험보고서", "물리 레포트", "캡스톤", "capstone", "엑셀 보고서"],
    free: ["범용 보고서", "리포트", "레포트", "문서 작성"],
    "reading-log": ["독후감", "독서록", "독서 보고서"],
    "reading-log-bulk": ["독서록 여러개", "독후감 대량", "책 목록"],
    "problem-set": ["문제지", "시험지", "문제 생성", "워크북", "학습지"],
    "vocabulary-book": ["단어장", "단어짱", "영단어", "영어 단어", "어휘", "보카", "vocabulary", "vocab", "영어교재", "엑셀 단어장"],
    "form-maker": ["서식", "템플릿", "양식 복원", "문서 사진"],
    "print-pdf-restore": ["프린트 복원", "사진 pdf 복원", "벡터 pdf", "수식 복원", "도해 복원", "ocr 검증"],
    "pdf-translate": ["번역", "통역", "translate", "영문 번역", "pdf 번역"],
    "cap-translate": ["cap 번역", "캡스톤 번역", "pasco 번역"],
    "file-convert": ["변환", "pdf 합치기", "이미지 변환", "엑셀 csv"],
    equation: ["수식 변환", "한글 수식", "latex", "hwpx 수식"],
    "image-ocr": ["사진 글자", "문자인식", "이미지 텍스트", "ocr"],
    "word-count": ["글자수", "문자수", "단어수", "word count"],
    statistics: ["통계", "평균", "표준편차", "중앙값"],
    regression: ["회귀", "추세선", "r2", "선형 회귀"],
    "unit-convert": ["단위", "환산", "단위 계산기"],
    "table-analysis": ["엑셀", "excel", "xlsx", "csv", "표 분석", "데이터 분석"],
    graph: ["차트", "그래프", "산점도", "막대그래프"],
    "file-chat": ["문서 질문", "파일 대화", "pdf 챗"],
    "quilo-schedule": ["학급 일정", "2학년 4반", "시간표", "반 공지", "학급 자료실"],
    "my-jobs": ["작업 내역", "생성 현황", "진행 상태"],
    "my-files": ["파일함", "생성 파일", "다운로드"],
  });

  const SEARCH_PINNED = ["vocabulary-book", "problem-set", "phys-result", "chem-pre", "pdf-translate", "file-convert"];
  const HIDDEN_FEATURE_IDS = new Set(["quilo-schedule"]);
  let adminViewer = false;

  const escapeHtml = (value) => String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  const featureMap = new Map(FALLBACK_FEATURES.map((feature) => [feature.id, feature]));

  function feature(id) {
    if (HIDDEN_FEATURE_IDS.has(id)) return null;
    const item = featureMap.get(id) || null;
    if (item?.audience === "admin" && !adminViewer) return null;
    return item;
  }

  function tierLabel(item) {
    if (!item) return "";
    if (item.status === "paused") return "준비 중";
    if (item.audience === "public") return "Public";
    if (item.audience === "member") return "Free";
    if (item.audience === "pro") return "Pro";
    if (item.audience === "max") return "Max";
    if (item.audience === "admin") return "Admin";
    return "";
  }

  function reportTypeForPath(path) {
    try { return new URL(String(path || "/"), window.location.origin).searchParams.get("report") || ""; }
    catch (_) { return ""; }
  }

  function groupModel() {
    const items = (ids) => ids.map(feature).filter(Boolean);
    return [
      {
        label: "제품",
        sections: [
          { title: "보고서", items: items(["chem-pre", "chem-result", "phys-result", "free", "reading-log"]) },
          { title: "문서 제작", items: items(["reading-log-bulk", "form-maker", "print-pdf-restore", "problem-set"]) },
          { title: "추천 작업", items: items(["pdf-translate", "file-convert", "create"]) },
        ],
        all: { title: "전체 기능 보기", path: "/developers.html#catalog" },
      },
      {
        label: "학습",
        sections: [
          { title: "연습", items: items(["coding-test"]) },
          { title: "시험 대비", items: items(["problem-set", "vocabulary-book"]) },
          { title: "심화 학습", items: items(["physics-studio", "relativity-study", "file-chat"]) },
          { title: "학급", items: items(["quilo-schedule"]) },
        ],
        all: { title: "학습 기능 전체 보기", path: "/developers.html#catalog" },
      },
      {
        label: "창작",
        sections: [
          { title: "만들기", items: items(["create", "vibe-coding", "quilo-code"]) },
          { title: "앱", items: STATIC_LINKS.apps },
        ],
        all: { title: "창작 갤러리 보기", path: "/create.html" },
      },
      {
        label: "파일 및 번역",
        sections: [
          { title: "번역", items: items(["pdf-translate", "cap-translate"]) },
          { title: "문서 도구", items: items(["file-convert", "equation", "image-ocr", "pdf-analysis"]) },
        ],
        all: { title: "브라우저 도구 전체 보기", path: "/tools/index.html" },
      },
      {
        label: "개발자",
        sections: [
          { title: "시작하기", items: STATIC_LINKS.developer.slice(0, 2) },
          { title: "관리", items: STATIC_LINKS.developer.slice(2) },
        ],
        all: { title: "개발자 플랫폼 열기", path: "/developers.html" },
      },
      {
        label: "리소스",
        sections: [
          { title: "읽고 배우기", items: STATIC_LINKS.resources.slice(0, 4) },
          { title: "Quilo", items: STATIC_LINKS.resources.slice(4) },
        ],
        all: { title: "이용 가이드 열기", path: "/guide.html" },
      },
    ].map((group) => ({ ...group, sections: group.sections.filter((section) => section.items.length) }));
  }

  function itemMarkup(item) {
    const path = String(item.path || "/");
    const report = reportTypeForPath(path);
    const reportData = report ? ` data-report="${escapeHtml(report)}"` : "";
    const tier = tierLabel(item);
    const tierMarkup = tier
      ? `<span class="ui-site-tier" data-tier="${escapeHtml(tier.toLowerCase().replace(/\s+/g, "-"))}">${escapeHtml(tier)}</span>`
      : "";
    return `<a class="ui-site-menu-item" href="${escapeHtml(path)}"${reportData}>
      <span class="ui-site-menu-item__copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.summary || "")}</small></span>
      ${tierMarkup}
    </a>`;
  }

  function panelMarkup(group) {
    return `<div class="ui-site-mega__layout">
      ${group.sections.map((section) => `<section class="ui-site-menu-section"><h2>${escapeHtml(section.title)}</h2><div>${section.items.map(itemMarkup).join("")}</div></section>`).join("")}
      <a class="ui-site-menu-all" href="${escapeHtml(group.all.path)}">${escapeHtml(group.all.title)}<span aria-hidden="true">→</span></a>
    </div>`;
  }

  function navTriggersMarkup(groups) {
    return groups.map((group, index) => `<button type="button" class="ui-site-nav-trigger" data-ui-menu-trigger="${index}" aria-expanded="false" aria-controls="uiSiteMega">${escapeHtml(group.label)}<span aria-hidden="true"></span></button>`).join("");
  }

  function mobileMarkup(groups) {
    return groups.map((group) => `<section class="ui-mobile-section"><h2>${escapeHtml(group.label)}</h2>${group.sections.flatMap((section) => section.items).map((item) => {
      const tier = tierLabel(item);
      const report = reportTypeForPath(item.path);
      return `<a href="${escapeHtml(item.path || "/")}"${report ? ` data-report="${escapeHtml(report)}"` : ""}><span>${escapeHtml(item.title)}</span>${tier ? `<small>${escapeHtml(tier)}</small>` : ""}</a>`;
    }).join("")}</section>`).join("");
  }

  function searchMarkup(id, mobile = false) {
    return `<div class="ui-feature-search${mobile ? " ui-feature-search--mobile" : ""}" data-ui-feature-search>
      <label class="ui-feature-search__field" for="${id}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4 4"></path></svg>
        <input id="${id}" type="search" inputmode="search" autocomplete="off" placeholder="기능 검색" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}Results" />
        <kbd aria-hidden="true">/</kbd>
      </label>
      <div class="ui-feature-search__panel" id="${id}Results" role="listbox" hidden>
        <div class="ui-feature-search__status" data-search-status></div>
        <div data-search-results></div>
      </div>
    </div>`;
  }

  function themeIcon(dark) {
    return dark
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"></path></svg>';
  }

  let groups = groupModel();

  function shellMarkup() {
    return `<div class="ui-site-header__inner">
      <a class="ui-site-brand" href="/" aria-label="Quilo 홈"><img src="/favicon.png" alt="" width="36" height="36" /><span>Quilo</span></a>
      <nav class="ui-site-nav" id="navMenu" aria-label="주요 메뉴">
        <div class="ui-site-nav__groups" data-ui-nav-groups>${navTriggersMarkup(groups)}</div>
        <a class="ui-site-link" href="/pricing.html">요금</a>
        <a class="ui-site-link ui-site-link--social" href="https://www.instagram.com/quilo._.official/" target="_blank" rel="noopener">Instagram<span class="ui-external-mark" aria-hidden="true">↗</span></a>
      </nav>
      ${searchMarkup("uiFeatureSearch")}
      <div class="ui-site-actions">
        <div class="ui-session-slot" id="accountSlot">
          <a class="ui-site-action ui-session-trigger" id="sessionAction" data-ui-auth-action href="${escapeHtml(loginUrlForCurrentPage())}" hidden><span id="user" data-ui-auth-label>로그인</span></a>
          <small class="ui-session-tier" id="accountTriggerMeta" aria-hidden="true" hidden>Account</small>
          <div class="ui-session-panel ui-login-panel" id="loginDd" hidden>
            <form id="loginForm" class="ui-login-form">
              <div class="ui-login-head"><span>Account sign in</span><strong>Quilo에 로그인</strong><p>작업과 생성 파일을 이어서 관리하세요.</p></div>
              <label for="li_username">아이디</label><input id="li_username" name="username" required maxlength="50" autocomplete="username" />
              <label for="li_password">비밀번호</label><input id="li_password" name="password" type="password" required autocomplete="current-password" />
              <label class="ui-login-remember"><input id="li_remember" name="remember" type="checkbox" checked /> 로그인 유지</label>
              <button type="submit" id="li_btn">로그인</button><p id="li_err" class="ui-login-error" role="alert" aria-live="polite"></p>
              <a class="ui-login-alt" href="/signup.html">계정 만들기</a>
            </form>
          </div>
          <div class="ui-session-panel ui-account-panel" id="acctDd" hidden>
            <div class="ui-account-head"><strong id="accountMenuName">내 계정</strong><span id="accountMenuMeta">Quilo Account</span></div>
            <a href="/#settings" data-tab="settings"><strong>Account Center</strong><span>계정, 사용량, 기본 설정</span></a>
            <a href="/#files" data-tab="files"><strong>내 파일</strong><span>최근 생성 파일</span></a>
            <a href="/#integrations" data-tab="integrations"><strong>외부 서비스 연결</strong><span>Dropbox와 API 연결</span></a>
            <a href="/support.html"><strong>고객센터</strong><span>문의, 버그 제보와 기능 제안</span></a>
            <a href="/admin.html" id="adminLink" hidden><strong>관리자</strong><span>운영 화면 열기</span></a>
            <button type="button" id="logout">로그아웃</button>
          </div>
        </div>
        <button type="button" class="ui-site-action ui-theme-toggle" id="themeToggle" data-ui-theme></button>
        <a class="ui-site-action ui-site-cta" data-ui-start-action href="/signup.html" hidden>무료로 시작하기</a>
      </div>
      <button type="button" class="ui-mobile-trigger" data-ui-mobile-trigger aria-expanded="false" aria-controls="uiMobilePanel"><span>메뉴</span><i aria-hidden="true"></i></button>
    </div>
    <div class="ui-site-scrim" data-ui-scrim aria-hidden="true"></div>
    <div class="ui-site-mega" id="uiSiteMega" aria-hidden="true"><div class="ui-site-mega__clip"><div class="ui-site-mega__inner" data-ui-mega-content></div></div></div>
    <div class="ui-mobile-panel" id="uiMobilePanel" aria-hidden="true"><div class="ui-mobile-search-wrap">${searchMarkup("uiMobileFeatureSearch", true)}</div><div class="ui-mobile-panel__inner" data-ui-mobile-content>${mobileMarkup(groups)}</div><div class="ui-mobile-actions"><a href="/pricing.html">요금</a><a href="https://www.instagram.com/quilo._.official/" target="_blank" rel="noopener">Instagram ↗</a><button type="button" data-ui-theme></button><a data-ui-auth-action href="${escapeHtml(loginUrlForCurrentPage())}" hidden><span data-ui-auth-label>로그인</span></a><a data-ui-mobile-admin href="/admin.html" hidden>관리자</a><button type="button" data-ui-mobile-logout hidden>로그아웃</button><a class="ui-site-cta" data-ui-start-action href="/signup.html" hidden>무료로 시작하기</a></div></div>`;
  }

  header.className = "ui-site-header";
  header.dataset.uiShell = "";
  header.dataset.uiShellMounted = "true";
  header.dataset.uiAuthState = "pending";
  header.setAttribute("aria-busy", "true");
  header.innerHTML = shellMarkup();

  const accountSlot = header.querySelector("#accountSlot");
  const loginPanel = header.querySelector("#loginDd");
  const accountPanel = header.querySelector("#acctDd");
  const megaPanel = header.querySelector("#uiSiteMega");
  const megaContent = header.querySelector("[data-ui-mega-content]");
  const scrim = header.querySelector("[data-ui-scrim]");
  const mobilePanel = header.querySelector("#uiMobilePanel");
  const mobileTrigger = header.querySelector("[data-ui-mobile-trigger]");
  const searchRoots = [...header.querySelectorAll("[data-ui-feature-search]")];
  const currentUrl = () => new URL(window.location.href);
  let currentAuthState = { state: "pending", user: null, status: null };
  let openMenuIndex = -1;

  function safeLocalReturnPath(value) {
    const raw = String(value || "").trim();
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "";
    try {
      const target = new URL(raw, location.origin);
      if (target.origin !== location.origin || ["/login", "/login.html"].includes(target.pathname)) return "";
      return `${target.pathname}${target.search}${target.hash}`;
    } catch (_) {
      return "";
    }
  }

  function currentReturnPath() {
    const url = new URL(location.href);
    const requested = safeLocalReturnPath(url.searchParams.get("next") || url.searchParams.get("returnTo"));
    if (requested) return requested;

    // Legacy login links used the home page as a desktop-only login launcher.
    // Do not send those launcher parameters back through the dedicated login page.
    url.searchParams.delete("login");
    url.searchParams.delete("next");
    url.searchParams.delete("returnTo");
    const search = url.searchParams.toString();
    return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
  }

  function loginUrlForCurrentPage() {
    return `/login.html?next=${encodeURIComponent(currentReturnPath())}`;
  }

  function authActions() { return [...header.querySelectorAll("[data-ui-auth-action]")]; }

  function accountName(user) {
    return String(user?.user || user?.name || user?.username || "내 계정").trim() || "내 계정";
  }

  function closeSessionPanel({ restoreFocus = false } = {}) {
    const trigger = header.querySelector("#sessionAction");
    const wasOpen = accountSlot?.classList.contains("is-open");
    accountSlot?.classList.remove("is-open");
    loginPanel?.classList.remove("open");
    accountPanel?.classList.remove("open");
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus && wasOpen) trigger?.focus();
  }

  function closeMega({ restoreFocus = false } = {}) {
    const trigger = openMenuIndex >= 0 ? header.querySelector(`[data-ui-menu-trigger="${openMenuIndex}"]`) : null;
    header.classList.remove("has-open-menu");
    megaPanel?.classList.remove("is-open");
    megaPanel?.setAttribute("aria-hidden", "true");
    scrim?.setAttribute("aria-hidden", "true");
    header.querySelectorAll("[data-ui-menu-trigger]").forEach((button) => button.setAttribute("aria-expanded", "false"));
    openMenuIndex = -1;
    if (restoreFocus) trigger?.focus();
  }

  function closeMobile({ restoreFocus = false } = {}) {
    header.classList.remove("has-open-mobile");
    mobilePanel?.setAttribute("aria-hidden", "true");
    mobileTrigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) mobileTrigger?.focus();
  }

  function closeSearchRoot(root) {
    const input = root?.querySelector("input[role='combobox']");
    const panel = root?.querySelector("[role='listbox']");
    root?.classList.remove("is-open");
    if (panel) panel.hidden = true;
    input?.setAttribute("aria-expanded", "false");
    input?.removeAttribute("aria-activedescendant");
  }

  function closeSearches(except = null) {
    searchRoots.forEach((root) => { if (root !== except) closeSearchRoot(root); });
  }

  function closeDropdowns(options = {}) {
    closeMega(options);
    closeMobile(options);
    closeSessionPanel(options);
    closeSearches();
  }

  function normalizeSearch(value) {
    return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function compactSearch(value) { return normalizeSearch(value).replace(/\s+/g, ""); }

  function editSimilarity(left, right) {
    const a = [...compactSearch(left)];
    const b = [...compactSearch(right)];
    if (!a.length || !b.length) return 0;
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const saved = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = saved;
      }
    }
    return 1 - row[b.length] / Math.max(a.length, b.length);
  }

  function bigramSimilarity(left, right) {
    const grams = (value) => {
      const text = compactSearch(value);
      if (text.length < 2) return [text];
      return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
    };
    const a = grams(left);
    const b = grams(right);
    if (!a[0] || !b[0]) return 0;
    const remaining = [...b];
    let overlap = 0;
    for (const gram of a) {
      const index = remaining.indexOf(gram);
      if (index >= 0) { overlap += 1; remaining.splice(index, 1); }
    }
    return (2 * overlap) / (a.length + b.length);
  }

  function searchTerms(item) {
    return [item.title, item.id, ...(item.keywords || []), ...(SEARCH_ALIASES[item.id] || [])].filter(Boolean);
  }

  function searchScore(item, query) {
    const q = normalizeSearch(query);
    const compact = compactSearch(q);
    if (!compact) return 0;
    const title = compactSearch(item.title);
    const id = compactSearch(item.id);
    const terms = searchTerms(item);
    const keywords = terms.slice(2).map(compactSearch);
    const corpus = compactSearch([item.title, item.id, item.summary, item.category, ...terms.slice(2)].join(" "));
    let score = 0;
    if (title === compact || id === compact) score = 130;
    else if (keywords.includes(compact)) score = 120;
    else if (title.startsWith(compact)) score = 108;
    else if (keywords.some((term) => term.startsWith(compact))) score = 102;
    else if (title.includes(compact)) score = 94;
    else if (keywords.some((term) => term.includes(compact))) score = 88;
    else if (corpus.includes(compact)) score = 78;
    const queryTokens = q.split(/\s+/).filter(Boolean);
    const hits = queryTokens.filter((token) => corpus.includes(compactSearch(token))).length;
    if (queryTokens.length > 1) score = Math.max(score, 52 + Math.round((hits / queryTokens.length) * 38));
    const fuzzy = Math.max(...terms.map((term) => Math.max(editSimilarity(compact, term), bigramSimilarity(compact, term))), 0);
    return Math.max(score, Math.round(fuzzy * 86));
  }

  function searchFeatures(query) {
    if (!normalizeSearch(query)) return SEARCH_PINNED.map(feature).filter(Boolean);
    return [...featureMap.values()]
      .filter((item) => !HIDDEN_FEATURE_IDS.has(item.id))
      .filter((item) => item.audience !== "admin" || adminViewer)
      .map((item) => ({ item, score: searchScore(item, query) }))
      .filter(({ score }) => score >= 38)
      .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, "ko"))
      .map(({ item }) => item);
  }

  function searchResultMarkup(item, inputId, index) {
    const tier = tierLabel(item);
    const report = reportTypeForPath(item.path);
    return `<a id="${inputId}Option${index}" class="ui-feature-search__result" href="${escapeHtml(item.path || "/")}" role="option" aria-selected="false" data-search-index="${index}"${report ? ` data-report="${escapeHtml(report)}"` : ""}>
      <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.summary || "")}</small></span>
      ${tier ? `<em>${escapeHtml(tier)}</em>` : ""}
    </a>`;
  }

  function setupFeatureSearch(root) {
    const input = root.querySelector("input[role='combobox']");
    const panel = root.querySelector("[role='listbox']");
    const status = root.querySelector("[data-search-status]");
    const resultsNode = root.querySelector("[data-search-results]");
    if (!input || !panel || !resultsNode) return;
    let results = [];
    let activeIndex = -1;

    const setActive = (index) => {
      const links = [...resultsNode.querySelectorAll("[data-search-index]")];
      if (!links.length) { activeIndex = -1; return; }
      activeIndex = (index + links.length) % links.length;
      links.forEach((link, linkIndex) => link.setAttribute("aria-selected", String(linkIndex === activeIndex)));
      input.setAttribute("aria-activedescendant", links[activeIndex].id);
      links[activeIndex].scrollIntoView({ block: "nearest" });
    };

    const render = () => {
      const query = input.value.trim();
      results = searchFeatures(query);
      activeIndex = -1;
      if (status) status.textContent = query ? `비슷한 기능 ${results.length}개` : "추천 기능";
      resultsNode.innerHTML = results.length
        ? results.map((item, index) => searchResultMarkup(item, input.id, index)).join("")
        : `<p class="ui-feature-search__empty">비슷한 기능을 찾지 못했습니다. 다른 단어로 검색해 보세요.</p>`;
      panel.hidden = false;
      root.classList.add("is-open");
      input.setAttribute("aria-expanded", "true");
      input.removeAttribute("aria-activedescendant");
    };
    root._refreshFeatureSearch = () => { if (root.classList.contains("is-open")) render(); };

    input.addEventListener("focus", () => {
      closeMega();
      closeSessionPanel();
      closeSearches(root);
      render();
    });
    input.addEventListener("input", render);
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!root.classList.contains("is-open")) render();
        setActive(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter" && activeIndex >= 0 && results[activeIndex]) {
        event.preventDefault();
        location.assign(results[activeIndex].path || "/");
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSearchRoot(root);
      }
    });
    resultsNode.addEventListener("mousemove", (event) => {
      const option = event.target.closest?.("[data-search-index]");
      if (option) setActive(Number(option.dataset.searchIndex));
    });
    resultsNode.addEventListener("click", () => closeSearchRoot(root));
  }

  searchRoots.forEach(setupFeatureSearch);

  function openMega(index) {
    const group = groups[index];
    if (!group || !megaPanel || !megaContent) return;
    closeSessionPanel();
    closeMobile();
    closeSearches();
    openMenuIndex = index;
    megaContent.innerHTML = panelMarkup(group);
    header.querySelectorAll("[data-ui-menu-trigger]").forEach((button) => {
      button.setAttribute("aria-expanded", String(Number(button.dataset.uiMenuTrigger) === index));
    });
    megaPanel.setAttribute("aria-hidden", "false");
    scrim?.setAttribute("aria-hidden", "false");
    header.classList.add("has-open-menu");
    requestAnimationFrame(() => megaPanel.classList.add("is-open"));
  }

  function openSessionPanel(kind) {
    if (!accountSlot || ["unknown", "pending"].includes(currentAuthState.state)) return false;
    closeMega();
    closeMobile();
    closeSearches();
    const expected = kind || (currentAuthState.state === "authenticated" ? "account" : "login");
    if (loginPanel) loginPanel.hidden = expected !== "login";
    if (accountPanel) accountPanel.hidden = expected !== "account";
    loginPanel?.classList.toggle("open", expected === "login");
    accountPanel?.classList.toggle("open", expected === "account");
    accountSlot.classList.add("is-open");
    header.querySelector("#sessionAction")?.setAttribute("aria-expanded", "true");
    if (expected === "login") requestAnimationFrame(() => header.querySelector("#li_username")?.focus());
    return true;
  }

  function openLoginFlow() {
    if (window.matchMedia?.("(max-width: 1120px)").matches) {
      closeDropdowns();
      location.assign(loginUrlForCurrentPage());
      return true;
    }
    return openSessionPanel("login");
  }

  header.addEventListener("click", (event) => {
    const menuTrigger = event.target.closest?.("[data-ui-menu-trigger]");
    if (menuTrigger) {
      const index = Number(menuTrigger.dataset.uiMenuTrigger);
      if (openMenuIndex === index && megaPanel?.classList.contains("is-open")) closeMega({ restoreFocus: true });
      else openMega(index);
      return;
    }
    if (event.target.closest?.("[data-ui-scrim]")) {
      closeDropdowns({ restoreFocus: true });
      return;
    }
    const mobileButton = event.target.closest?.("[data-ui-mobile-trigger]");
    if (mobileButton) {
      const opening = !header.classList.contains("has-open-mobile");
      closeMega();
      closeSessionPanel();
      header.classList.toggle("has-open-mobile", opening);
      mobilePanel?.setAttribute("aria-hidden", String(!opening));
      mobileTrigger?.setAttribute("aria-expanded", String(opening));
    }
  });

  header.querySelector("#sessionAction")?.addEventListener("click", (event) => {
    if (!["anonymous", "authenticated"].includes(currentAuthState.state)) return;
    event.preventDefault();
    if (accountSlot?.classList.contains("is-open")) closeSessionPanel();
    else openSessionPanel();
  });

  document.addEventListener("pointerdown", (event) => {
    if (!header.contains(event.target)) closeDropdowns();
    else if (!event.target.closest?.("[data-ui-feature-search]")) closeSearches();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDropdowns({ restoreFocus: true });
    if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || "") && !event.target?.isContentEditable) {
      const desktopInput = header.querySelector(".ui-feature-search:not(.ui-feature-search--mobile) input");
      if (desktopInput && desktopInput.offsetParent !== null) {
        event.preventDefault();
        desktopInput.focus();
      }
    }
  });

  function syncCurrentLinks() {
    const here = currentUrl();
    header.querySelectorAll("a[href]").forEach((link) => {
      let target;
      try { target = new URL(link.href, here); } catch (_) { return; }
      if (target.origin === here.origin && target.pathname === here.pathname && target.search === here.search && target.hash === here.hash) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }
  syncCurrentLinks();

  function syncTheme() {
    const dark = document.documentElement.dataset.theme === "dark";
    header.querySelectorAll("[data-ui-theme]").forEach((button) => {
      button.setAttribute("aria-pressed", String(dark));
      button.setAttribute("aria-label", dark ? "라이트 테마로 변경" : "다크 테마로 변경");
      button.setAttribute("title", dark ? "라이트 테마로 변경" : "다크 테마로 변경");
      button.innerHTML = themeIcon(dark);
    });
  }

  const usesThemeJs = [...document.scripts].some((script) => {
    try { return new URL(script.src, currentUrl()).pathname === "/theme.js"; } catch (_) { return false; }
  });
  if (!usesThemeJs) {
    header.querySelectorAll("[data-ui-theme]").forEach((button) => button.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("theme", next); } catch (_) {}
      syncTheme();
    }));
  }
  document.addEventListener("quilo:theme-change", syncTheme);
  syncTheme();

  function renderAuthState(result) {
    const previousState = currentAuthState.state;
    currentAuthState = result;
    if (result.state === "authenticated") storagePrivacy.protect(result.user?.id);
    else if (result.state === "anonymous") storagePrivacy.signOut();
    const nextAdminViewer = result.state === "authenticated" && result.user?.isAdmin === true;
    if (adminViewer !== nextAdminViewer) {
      adminViewer = nextAdminViewer;
      groups = groupModel();
      closeMega();
      const nav = header.querySelector("[data-ui-nav-groups]");
      const mobile = header.querySelector("[data-ui-mobile-content]");
      if (nav) nav.innerHTML = navTriggersMarkup(groups);
      if (mobile) mobile.innerHTML = mobileMarkup(groups);
      searchRoots.forEach((root) => root._refreshFeatureSearch?.());
    }
    header.dataset.uiAuthState = result.state;
    header.setAttribute("aria-busy", "false");
    document.body.dataset.sessionState = result.state;
    if (previousState !== result.state) closeDropdowns();

    const authenticated = result.state === "authenticated";
    const anonymous = result.state === "anonymous";
    const name = authenticated ? accountName(result.user) : "";
    const compactName = [...name].length > 14 ? `${[...name].slice(0, 14).join("")}…` : name;

    document.querySelectorAll("[data-ui-start-action]").forEach((action) => {
      action.href = "/signup.html";
      action.textContent = "무료로 시작하기";
      action.hidden = !anonymous;
    });

    if (loginPanel) loginPanel.hidden = !anonymous;
    if (accountPanel) accountPanel.hidden = !authenticated;
    const adminLink = header.querySelector("#adminLink");
    if (adminLink) adminLink.hidden = !authenticated || result.user?.isAdmin !== true;
    const mobileAdminLink = header.querySelector("[data-ui-mobile-admin]");
    if (mobileAdminLink) mobileAdminLink.hidden = !authenticated || result.user?.isAdmin !== true;
    const mobileLogout = header.querySelector("[data-ui-mobile-logout]");
    if (mobileLogout) mobileLogout.hidden = !authenticated;
    const accountMenuName = header.querySelector("#accountMenuName");
    if (accountMenuName && authenticated) accountMenuName.textContent = name;
    const accountTier = header.querySelector("#accountTriggerMeta");
    if (accountTier) accountTier.hidden = !authenticated;

    authActions().forEach((action) => {
      const label = action.querySelector("[data-ui-auth-label]") || action;
      action.hidden = false;
      action.dataset.uiAuthState = result.state;
      action.removeAttribute("title");
      if (authenticated) {
        label.textContent = `${compactName} 님`;
        action.href = "/#settings";
        action.setAttribute("aria-label", `${name} Account Center 열기`);
      } else if (anonymous) {
        label.textContent = "로그인";
        action.href = loginUrlForCurrentPage();
        action.setAttribute("aria-label", "Quilo 로그인");
      } else {
        label.textContent = "계정 확인";
        action.href = "/";
        action.setAttribute("aria-label", "로그인 상태를 다시 확인하려면 홈으로 이동");
        action.title = "로그인 상태를 확인하지 못했습니다.";
      }
    });

    try { document.dispatchEvent(new CustomEvent("quilo:auth-state", { detail: result })); } catch (_) {}
    return result;
  }

  let authSyncPromise = null;
  async function syncAuthState() {
    if (authSyncPromise) return authSyncPromise;
    authSyncPromise = (async () => {
      try {
        const response = await fetch("/api/me", { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
        if (response.status === 401) return renderAuthState({ state: "anonymous", user: null, status: 401 });
        if (!response.ok) return renderAuthState({ state: "unknown", user: currentAuthState.user, status: response.status });
        return renderAuthState({ state: "authenticated", user: await response.json(), status: response.status });
      } catch (_) {
        return renderAuthState({ state: "unknown", user: currentAuthState.user, status: 0 });
      } finally {
        authSyncPromise = null;
      }
    })();
    return authSyncPromise;
  }

  const AUTH_SYNC_KEY = "quilo:auth-sync";
  const authChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("quilo-auth") : null;
  function notifyAuthChange(action = "change") {
    const message = { action, at: Date.now() };
    try { authChannel?.postMessage(message); } catch (_) {}
    try { localStorage.setItem(AUTH_SYNC_KEY, JSON.stringify(message)); } catch (_) {}
  }
  authChannel?.addEventListener("message", () => { void syncAuthState(); });
  window.addEventListener("storage", (event) => {
    if (event.key === AUTH_SYNC_KEY) void syncAuthState();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void syncAuthState();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncAuthState();
  });
  let lastFocusSync = 0;
  window.addEventListener("focus", () => {
    if (Date.now() - lastFocusSync < 1000) return;
    lastFocusSync = Date.now();
    void syncAuthState();
  });
  window.addEventListener("popstate", syncCurrentLinks);

  const authReady = syncAuthState();
  window.QuiloShellAuth = Object.freeze({ ready: authReady, refresh: syncAuthState, current: () => currentAuthState, notify: notifyAuthChange });
  window.QuiloSiteShell = Object.freeze({ closeDropdowns, openLogin: openLoginFlow, openAccount: () => openSessionPanel("account") });

  fetch("/api/catalog", { headers: { accept: "application/json" } })
    .then((response) => response.ok ? response.json() : null)
    .then((data) => {
      if (!Array.isArray(data?.features) || !data.features.length) return;
      const retired = new Set(["eng-exam-prep", "korean-lit-exam", "phys-inquiry", "math-inquiry", "phys-mock-exam"]);
      data.features.forEach((item) => {
        if (!retired.has(item.id)) featureMap.set(item.id, item);
      });
      groups = groupModel();
      closeMega();
      const nav = header.querySelector("[data-ui-nav-groups]");
      const mobile = header.querySelector("[data-ui-mobile-content]");
      if (nav) nav.innerHTML = navTriggersMarkup(groups);
      if (mobile) mobile.innerHTML = mobileMarkup(groups);
      searchRoots.forEach((root) => root._refreshFeatureSearch?.());
      syncCurrentLinks();
    })
    .catch(() => {});

  const prefetched = new Set();
  function prefetchPage(link) {
    if (!(link instanceof HTMLAnchorElement)) return;
    const here = currentUrl();
    const target = new URL(link.href, here);
    if (target.origin !== here.origin || target.pathname === here.pathname) return;
    const key = `${target.pathname}${target.search}`;
    if (prefetched.has(key)) return;
    prefetched.add(key);
    const hint = document.createElement("link");
    hint.rel = "prefetch";
    hint.href = key;
    hint.as = "document";
    document.head.appendChild(hint);
  }
  document.addEventListener("pointerover", (event) => {
    const link = event.target.closest?.("a[href]");
    if (link) prefetchPage(link);
  }, { passive: true });
  document.addEventListener("focusin", (event) => {
    const link = event.target.closest?.("a[href]");
    if (link) prefetchPage(link);
  });

  const isWorkspace = document.body.classList.contains("home-page");
  if (!isWorkspace) {
    header.querySelector("#loginForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = header.querySelector("#li_btn");
      const error = header.querySelector("#li_err");
      if (button) { button.disabled = true; button.textContent = "로그인 중..."; }
      if (error) error.textContent = "";
      try {
        const response = await fetch("/api/login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ username: header.querySelector("#li_username")?.value || "", password: header.querySelector("#li_password")?.value || "", remember: header.querySelector("#li_remember")?.checked !== false }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "로그인하지 못했습니다.");
        storagePrivacy.protect(data.id);
        notifyAuthChange("login");
        location.reload();
      } catch (exception) {
        if (error) error.textContent = exception.message;
        if (button) { button.disabled = false; button.textContent = "로그인"; }
      }
    });
    header.querySelectorAll("#logout, [data-ui-mobile-logout]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        let response;
        try {
          response = await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
        } catch (_) {
          button.disabled = false;
          return;
        }
        if (!response.ok) {
          button.disabled = false;
          return;
        }
        storagePrivacy.signOut();
        notifyAuthChange("logout");
        location.assign("/");
      });
    });
  }

  document.querySelectorAll(".ui-site-footer, body.home-page > footer.site-footer").forEach((footer) => {
    footer.className = "ui-site-footer";
    footer.innerHTML = `<div class="ui-site-footer__inner">
      <section class="ui-site-footer__brand"><a href="/" class="ui-site-footer__logo">Quilo</a><p>학습과 연구의 전 과정을 연결하는 AI Workspace.</p><nav aria-label="Quilo 외부 채널"><a href="https://www.instagram.com/quilo._.official/" target="_blank" rel="noopener">Instagram ↗</a><a href="https://github.com/fakeminjun7321/Quilo" target="_blank" rel="noopener">GitHub ↗</a><a href="https://blog.naver.com/physicjun1905" target="_blank" rel="noopener">블로그 ↗</a></nav></section>
      <nav class="ui-site-footer__nav" aria-label="푸터 메뉴">
        <section><h2>제품</h2><a href="/?report=chem-pre">화학 사전보고서</a><a href="/?report=phys-result">물리 결과보고서</a><a href="/?report=free">자유 보고서</a><a href="/translate.html">PDF 통번역</a></section>
        <section><h2>학습 및 창작</h2><a href="/?report=problem-set">문제집 메이커</a><a href="/?report=reading-log">독서활동 기록지</a><a href="/create.html">창작 스튜디오</a><a href="/editor.html">Quilo Code</a></section>
        <section><h2>개발자</h2><a href="/developers.html">개발자 플랫폼</a><a href="/developers.html#api">API 문서</a><a href="/developers.html#catalog">기능 카탈로그</a></section>
        <section><h2>리소스</h2><a href="/developer-notes.html">개발 노트</a><a href="/resources.html">자료실</a><a href="/guide.html">이용 가이드</a><a href="/community.html">커뮤니티</a><a href="/support.html">고객센터</a><a href="/changelog.html">업데이트</a><a href="/school-apply.html">학교 도입</a></section>
      </nav>
      <div class="ui-site-footer__legal"><span>© 2026 Quilo</span><nav aria-label="법적 고지"><a href="/terms.html">이용약관</a><a href="/privacy.html">개인정보처리방침</a><a href="/refund.html">환불정책</a><a href="/status.html">서비스 상태</a></nav><span data-site-version>버전 확인 중...</span></div>
    </div>`;
  });

  const downloadButtons = [...document.querySelectorAll("[data-app-download]")];
  const downloadStatus = document.querySelector("[data-app-download-status]");
  downloadButtons.forEach((button) => button.addEventListener("click", () => {
    const platform = button.dataset.platform === "mac" ? "macOS" : "Windows";
    const appName = button.dataset.app === "live-translator" ? "Live Translator" : "Quilo Desktop";
    if (downloadStatus) { downloadStatus.classList.remove("is-error"); downloadStatus.textContent = `${appName} ${platform} 다운로드를 시작했습니다.`; }
  }));

  const versionNodes = [...document.querySelectorAll("[data-site-version]")];
  if (versionNodes.length) {
    fetch("/api/version", { cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error("version fetch failed"); return response.json(); })
      .then((info) => {
        const release = info?.releaseVersion || info?.version;
        if (!release) throw new Error("version missing");
        const label = info.shortCommit ? `v${release} · ${info.shortCommit}` : `v${release}`;
        versionNodes.forEach((node) => { node.textContent = label; node.title = info.commit ? `commit ${info.commit}` : "현재 배포 버전"; });
      })
      .catch(() => versionNodes.forEach((node) => { node.textContent = "버전 확인 불가"; }));
  }
})();
