"use strict";

const express = require("express");
const multer = require("multer");
const { analyzeTableFile, equationToUnicode, wordCount } = require("./core");
const { describe, linearRegression } = require("./statistics");
const { convertUnit, unitCatalog } = require("./units");
const { renderPng, renderSvg } = require("./graph");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

function handler(fn) {
  return async (req, res) => {
    try {
      return await fn(req, res);
    } catch (error) {
      return res.status(400).json({ error: error.message || "계산 요청이 올바르지 않습니다." });
    }
  };
}

function createCalculationToolRouter({ requireAuth }) {
  const router = express.Router();
  router.post("/word-count", requireAuth, handler((req, res) => res.json(wordCount(req.body?.text))));
  router.post("/statistics", requireAuth, handler((req, res) => res.json({ statistics: describe(req.body?.values) })));
  router.post("/regression", requireAuth, handler((req, res) => res.json({ regression: linearRegression(req.body?.x, req.body?.y) })));
  router.get("/units", requireAuth, (_req, res) => res.json({ categories: unitCatalog() }));
  router.post("/units/convert", requireAuth, handler((req, res) => res.json(convertUnit(req.body?.value, req.body?.from, req.body?.to, req.body?.category))));
  router.post("/equations/convert", requireAuth, handler((req, res) => res.json(equationToUnicode(req.body?.expression))));
  router.post("/tables/analyze", requireAuth, upload.single("file"), handler((req, res) => {
    if (!req.file) throw new Error("CSV 또는 Excel 파일이 필요합니다.");
    return res.json({ analysis: analyzeTableFile(req.file.buffer, req.file.originalname) });
  }));
  router.post("/graphs", requireAuth, handler(async (req, res) => {
    const format = String(req.body?.format || "png").toLowerCase();
    if (!new Set(["png", "svg"]).has(format)) throw new Error("그래프 형식은 png 또는 svg여야 합니다.");
    const output = format === "svg" ? renderSvg(req.body) : await renderPng(req.body);
    res.set({ "Content-Type": format === "svg" ? "image/svg+xml; charset=utf-8" : "image/png", "Content-Length": String(output.length) });
    return res.send(output);
  }));
  return router;
}

module.exports = { createCalculationToolRouter };
