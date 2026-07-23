"use strict";

const SCOPE_DEFINITIONS = Object.freeze({
  "account:read": Object.freeze({
    title: "계정 읽기",
    description: "본인의 Quilo 계정, 등급, 크레딧 요약을 확인합니다.",
    access: "read",
  }),
  "jobs:read": Object.freeze({
    title: "작업 읽기",
    description: "본인이 만든 작업의 목록, 상태와 진행 로그를 확인합니다.",
    access: "read",
  }),
  "jobs:write": Object.freeze({
    title: "작업 관리",
    description: "본인이 실행 중인 작업을 중단합니다.",
    access: "write",
  }),
  "files:read": Object.freeze({
    title: "파일 읽기",
    description: "본인의 완료 파일 목록을 확인하고 다운로드합니다.",
    access: "read",
  }),
  "reports:write": Object.freeze({
    title: "보고서 생성",
    description: "Quilo 크레딧과 기존 권한 정책을 적용해 보고서 작업을 제출합니다.",
    access: "write",
    billable: true,
  }),
  "translations:read": Object.freeze({
    title: "번역 분석",
    description: "PDF 통번역 방식, 페이지 수, 예상 비용과 시간을 분석합니다.",
    access: "read",
  }),
  "translations:write": Object.freeze({
    title: "PDF 통번역",
    description: "Max 권한과 기존 사용량 정책을 적용해 PDF 통번역 작업을 제출합니다.",
    access: "write",
    billable: true,
  }),
  "conversions:write": Object.freeze({
    title: "문서 변환",
    description: "지원되는 문서를 다른 편집 가능한 형식으로 변환합니다.",
    access: "write",
  }),
  "documents:read": Object.freeze({
    title: "문서 분석",
    description: "사용자가 지정한 PDF의 구조와 메타데이터를 읽습니다.",
    access: "read",
  }),
  "documents:write": Object.freeze({
    title: "문서 처리",
    description: "사용자가 지정한 이미지 OCR과 HWPX 수식 변환을 실행합니다.",
    access: "write",
  }),
  "tools:read": Object.freeze({
    title: "계산 도구",
    description: "글자수, 통계, 회귀, 단위, 표 분석과 그래프 렌더링을 실행합니다.",
    access: "read",
  }),
  "webhooks:read": Object.freeze({
    title: "Webhook 읽기",
    description: "본인의 Webhook endpoint와 전송 기록을 확인합니다.",
    access: "read",
  }),
  "webhooks:write": Object.freeze({
    title: "Webhook 관리",
    description: "본인의 Webhook endpoint를 만들거나 삭제합니다.",
    access: "write",
  }),
  "integrations:read": Object.freeze({
    title: "외부 연동 읽기",
    description: "Dropbox, Google, Notion과 BYOK의 연결 상태만 확인합니다.",
    access: "read",
  }),
  "integrations:data": Object.freeze({
    title: "외부 연동 데이터 읽기",
    description: "연결된 Dropbox 링크와 Google Drive의 파일, 폴더, 댓글 및 파일 내용을 읽습니다.",
    access: "read",
  }),
  "integrations:write": Object.freeze({
    title: "외부 연동 실행",
    description: "연결된 사용자 계정으로 Drive 업로드, Google Docs와 Notion 페이지 생성을 실행합니다.",
    access: "write",
  }),
  "studios:read": Object.freeze({
    title: "스튜디오 설정 읽기",
    description: "사용 가능한 스튜디오 모델, 스타일과 비용 설정을 확인합니다.",
    access: "read",
  }),
  "studios:write": Object.freeze({
    title: "AI 스튜디오 생성",
    description: "Pro 권한과 크레딧 정책을 적용해 Vibe Coding과 물리 스튜디오를 실행합니다.",
    access: "write",
    billable: true,
  }),
  "chat:write": Object.freeze({
    title: "파일 챗봇",
    description: "사용자 지정 파일과 메시지를 Quilo 파일 챗봇에 전송합니다.",
    access: "write",
  }),
  "knowledge:read": Object.freeze({
    title: "Quilo 지식 읽기",
    description: "Quilo Lab의 공개 기술 문서와 메타데이터를 읽습니다.",
    access: "read",
  }),
  "community:read": Object.freeze({
    title: "커뮤니티 읽기",
    description: "Quilo 커뮤니티 글과 댓글을 읽습니다.",
    access: "read",
  }),
  "community:write": Object.freeze({
    title: "커뮤니티 쓰기",
    description: "본인 이름으로 글, 댓글, 공감 작업을 수행합니다.",
    access: "write",
  }),
});

const ALLOWED_SCOPES = new Set(Object.keys(SCOPE_DEFINITIONS));

function normalizeScopes(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map(String).filter((scope) => ALLOWED_SCOPES.has(scope)))];
}

function hasScope(scopes, requiredScope) {
  return normalizeScopes(scopes).includes(requiredScope);
}

function publicScopeDefinitions() {
  return Object.entries(SCOPE_DEFINITIONS).map(([id, definition]) => ({ id, ...definition }));
}

module.exports = {
  ALLOWED_SCOPES,
  SCOPE_DEFINITIONS,
  hasScope,
  normalizeScopes,
  publicScopeDefinitions,
};
