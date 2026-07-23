// 상대론 민코프스키 도식 기하 회귀 테스트 (plain Node, 러너 불필요).
// 실행: node tests/relativity-geometry.js
// 검증 대상: lib/study-routes.js 의 결정적 기하 보정(applyRelativityGeometry) + 템플릿 + 보정쌍곡선(computeCalibration).
// 핵심 규칙(x 가로, ct 세로, 기울기=d(ct)/dx): 정지=수직, 운동=1/β, 빛=±1,
//          드로잉 프레임 동시선=0, 움직이는 프레임 동시선=β.
const T = require("../lib/study-routes")._test;

let pass = 0,
  fail = 0;
const approx = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-6);
function check(name, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log("FAIL:", name, extra !== undefined ? JSON.stringify(extra) : "");
  }
}
const slope = (p0, p1) => (p1.x - p0.x === 0 ? Infinity : (p1.t - p0.t) / (p1.x - p0.x));
const segSlope = (s) => slope(s.from, s.to);
const wl = (spec, id) => spec.worldlines.find((w) => w.id === id);
const seg = (spec, label) => spec.segments.find((s) => s.label.includes(label));

const beta = 0.6;

// 길이수축: 막대 양끝 수직, 고유길이 수평(rest), 수축길이 기울기 β(moving), 관측자 1/β, 공간꼴 보정쌍곡선
let s = T.finalizeSpec(T.lengthContractionTemplate(), "막대 길이수축");
check("LC type", s.diagramType === "length-contraction", s.diagramType);
check("LC end_left vertical", slope(wl(s, "end_left").points[0], wl(s, "end_left").points[1]) === Infinity);
check("LC end_right vertical", slope(wl(s, "end_right").points[0], wl(s, "end_right").points[1]) === Infinity);
check("LC observer 1/beta", approx(slope(wl(s, "observer").points[0], wl(s, "observer").points[1]), 1 / beta));
check("LC proper horizontal", segSlope(seg(s, "고유길이")) === 0);
check("LC contracted slope=beta", approx(segSlope(seg(s, "수축길이")), beta));
check("LC calibration spacelike", s.calibration && s.calibration.axis === "x");
check("LC calibration k=8", s.calibration && approx(s.calibration.value, 8, 0.01), s.calibration && s.calibration.value);

// 뮤온계: 뮤온 수직, 지면 다가옴 -1/β, D 수평, D0 기울기 β
s = T.finalizeSpec(T.muonFrameLengthTemplate(), "뮤온 frame 길이수축");
check("MUON type", s.diagramType === "muon-frame-length-contraction");
check("MUON muon vertical", slope(wl(s, "muon").points[0], wl(s, "muon").points[1]) === Infinity);
check("MUON ground -1/beta", approx(slope(wl(s, "ground").points[0], wl(s, "ground").points[1]), -1 / beta));
check("MUON D horizontal", segSlope(seg(s, "수축거리")) === 0);
check("MUON D0 slope=beta", approx(segSlope(seg(s, "고유거리")), beta));

// 시간지연: 정지계 수직, 시계 1/β, 시간꼴 보정쌍곡선이 틱 사건을 지남(k=6.4)
s = T.finalizeSpec(T.timeDilationTemplate(), "시간지연");
check("TD type", s.diagramType === "time-dilation");
check("TD lab vertical", slope(wl(s, "lab").points[0], wl(s, "lab").points[1]) === Infinity);
check("TD clock 1/beta", approx(slope(wl(s, "clock").points[0], wl(s, "clock").points[1]), 1 / beta));
check("TD calibration timelike", s.calibration && s.calibration.axis === "t");
check("TD calibration k=6.4", s.calibration && approx(s.calibration.value, 6.4, 0.02), s.calibration && s.calibration.value);

// 동시성: S 동시 수평, S' 지금 기울기 β, 보정쌍곡선 없음
s = T.finalizeSpec(T.simultaneityTemplate(), "동시성");
check("SIM type", s.diagramType === "simultaneity");
check("SIM S-now horizontal", segSlope(seg(s, "S 동시")) === 0);
check("SIM Sprime-now slope=beta", approx(segSlope(seg(s, "S′ 지금")), 0.55));
check("SIM no calibration", !s.calibration);

// 쌍둥이: 지구 수직, 여행자 꺾인(보정 안 됨) 다리별 ±1/β, 시간꼴 보정쌍곡선
s = T.finalizeSpec(T.twinParadoxTemplate(), "쌍둥이 역설");
check("TWIN type", s.diagramType === "twin-paradox");
check("TWIN earth vertical", slope(wl(s, "earth").points[0], wl(s, "earth").points[1]) === Infinity);
const tp = wl(s, "traveler").points;
check("TWIN traveler bent (3pts kept)", tp.length === 3, tp.length);
check("TWIN out 1/beta", approx(slope(tp[0], tp[1]), 1 / beta));
check("TWIN in -1/beta", approx(slope(tp[1], tp[2]), -1 / beta));
check("TWIN calibration timelike", s.calibration && s.calibration.axis === "t");

// 빛신호: 송신 +1, 수신 -1, 보정쌍곡선 없음
s = T.finalizeSpec(T.lightSignalTemplate(), "빛 신호 왕복 광원뿔");
check("LIGHT type", s.diagramType === "light-signal");
check("LIGHT out +1", approx(slope(wl(s, "out").points[0], wl(s, "out").points[1]), 1));
check("LIGHT back -1", approx(slope(wl(s, "back").points[0], wl(s, "back").points[1]), -1));
check("LIGHT no calibration", !s.calibration);

// 프롬프트 라우팅
check("route twin", T.inferPromptKind("쌍둥이 역설을 간단한 민코프스키 평면으로") === "twin-paradox");
check("route light", T.inferPromptKind("빛 신호가 왕복하는 상황을 광원뿔로") === "light-signal");
check("route length", T.inferPromptKind("막대의 길이수축을 움직이는 관찰자 입장에서") === "length-contraction");
check("route time", T.inferPromptKind("움직이는 시계의 시간지연을 민코프스키 도표로") === "time-dilation");
check("route sim", T.inferPromptKind("열차 안 두 번개 사건의 동시성 상대성") === "simultaneity");
check("route muon->muon template", T.inferTextTemplate("뮤온 frame에서 뮤온과 지면 사이의 길이 수축").diagramType === "muon-frame-length-contraction");

// 하위호환: 태그 없는 좌표는 그대로 통과
const raw = {
  diagramType: "minkowski-clean",
  beta: 0.5,
  worldlines: [{ id: "w", points: [{ x: 1, t: 0 }, { x: 3, t: 7 }] }],
  segments: [{ label: "x", from: { x: 1, t: 1 }, to: { x: 4, t: 1 } }],
  events: [],
  annotations: [],
};
const fr = T.finalizeSpec(raw, "");
check("backcompat worldline unchanged", approx(fr.worldlines[0].points[1].x, 3) && approx(fr.worldlines[0].points[1].t, 7));
check("backcompat segment unchanged", approx(fr.segments[0].to.x, 4) && approx(fr.segments[0].to.t, 1));
check("clean no calibration", !fr.calibration);

// 모델이 잘못 준 기울기를 normalizer가 β로 바로잡는다(과거 동시성 버그 방지)
const wrong = {
  diagramType: "simultaneity",
  beta: 0.55,
  worldlines: [],
  events: [],
  annotations: [],
  segments: [{ label: "S′ 지금", simultaneity: "moving", from: { x: 2, t: 3 }, to: { x: 10, t: 5 } }],
};
check("normalizer fixes wrong slope to beta", approx(segSlope(T.finalizeSpec(wrong, "").segments[0]), 0.55));

// placeholder 주석은 버린다
const noisy = T.finalizeSpec(
  { diagramType: "minkowski-clean", beta: 0.5, events: [], worldlines: [], segments: [], annotations: [{ label: "주석 1" }, { label: "" }, { label: "빛 신호" }] },
  "",
);
check("drop placeholder annotations", noisy.annotations.length === 1 && noisy.annotations[0].label === "빛 신호", noisy.annotations);

console.log("\nrelativity-geometry:", pass, "passed,", fail, "failed");
process.exit(fail ? 1 : 0);
