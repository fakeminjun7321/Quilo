"use strict";

const VOCABULARY_DESIGNS = Object.freeze({
  science: Object.freeze({
    id: "science",
    label: "사이언스 블루",
    description: "파란 단원 바와 구조적인 교재 레이아웃",
  }),
  classic: Object.freeze({
    id: "classic",
    label: "클래식 교재형",
    description: "짙은 남색과 아이보리의 전통적인 학술 구성",
  }),
  minimal: Object.freeze({
    id: "minimal",
    label: "미니멀 암기형",
    description: "장식을 줄이고 여백과 핵심 뜻에 집중한 구성",
  }),
});

const DEFAULT_VOCABULARY_DESIGN = "science";

function normalizeVocabularyDesign(value) {
  const key = String(value || "").trim().toLowerCase();
  return Object.hasOwn(VOCABULARY_DESIGNS, key) ? key : DEFAULT_VOCABULARY_DESIGN;
}

function vocabularyDesignLabel(value) {
  return VOCABULARY_DESIGNS[normalizeVocabularyDesign(value)].label;
}

module.exports = {
  VOCABULARY_DESIGNS,
  DEFAULT_VOCABULARY_DESIGN,
  normalizeVocabularyDesign,
  vocabularyDesignLabel,
};
