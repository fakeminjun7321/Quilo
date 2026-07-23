"use strict";

const express = require("express");
const { API_V1_ROUTES } = require("./registry");
const { SCOPE_DEFINITIONS } = require("./scopes");

function operationFor(entry) {
  const parameters = [];
  if (entry.path.includes("{id}")) {
    parameters.push({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string", minLength: 1 },
    });
  }
  if (entry.operationId === "downloadJob") {
    parameters.push({
      name: "file",
      in: "query",
      required: false,
      schema: { type: "integer", minimum: 0 },
      description: "다중 파일 작업의 파일 인덱스",
    });
  }

  const operation = {
    operationId: entry.operationId,
    summary: entry.summary,
    tags: [routeTag(entry.path)],
    security: [{ bearerAuth: [entry.scope] }],
    "x-quilo-scope": entry.scope,
    ...(entry.idempotent ? { "x-quilo-idempotency-required": true } : {}),
    parameters,
    responses: {
      200: { description: "성공" },
      401: { $ref: "#/components/responses/Unauthorized" },
      403: { $ref: "#/components/responses/Forbidden" },
      404: { $ref: "#/components/responses/NotFound" },
    },
  };
  if (entry.idempotent) {
    operation.parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 8, maxLength: 200 },
      description: "같은 작업의 중복 실행·중복 과금을 막는 24시간 키",
    });
  }
  if (["createReport", "estimatePdfTranslation", "createPdfTranslation", "convertDocxToHwpx", "analyzePdf", "convertHwpxEquations", "ocrImage"].includes(entry.operationId)) {
    const isReport = entry.operationId === "createReport";
    const isDocx = entry.operationId === "convertDocxToHwpx";
    const isPdfAnalysis = entry.operationId === "analyzePdf";
    const isHwpxEquations = entry.operationId === "convertHwpxEquations";
    const isImageOcr = entry.operationId === "ocrImage";
    operation.requestBody = {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            required: isReport ? ["type"] : [isDocx ? "docx" : isHwpxEquations ? "hwpx" : isImageOcr ? "image" : "pdf"],
            properties: isReport
              ? {
                  type: { type: "string", description: "Quilo 보고서 pipeline id" },
                  format: { type: "string", enum: ["docx", "hwpx"] },
                  model: { type: "string" },
                }
              : isDocx
                ? { docx: { type: "string", format: "binary" } }
                : isHwpxEquations
                  ? {
                      hwpx: { type: "string", format: "binary" },
                      mode: { type: "string", enum: ["all", "latex", "placeholders"], default: "all" },
                    }
                  : isImageOcr
                    ? {
                        image: { type: "string", format: "binary" },
                        includeBlocks: { type: "boolean", default: false },
                      }
                    : isPdfAnalysis
                      ? { pdf: { type: "string", format: "binary" } }
                : {
                    pdf: { type: "string", format: "binary" },
                    mode: { type: "string", enum: ["auto", "inplace", "retypeset"] },
                    modes: {
                      type: "string",
                      description: "여러 PDF와 같은 순서의 mode JSON 배열",
                      example: '["inplace","retypeset"]',
                    },
                    renderer: {
                      type: "string",
                      enum: ["auto", "tectonic", "libreoffice"],
                      default: "auto",
                      description: "재조판 출력 엔진. inplace는 항상 PyMuPDF를 사용",
                    },
                    renderers: {
                      type: "string",
                      description: "여러 PDF와 같은 순서의 renderer JSON 배열",
                      example: '["auto","libreoffice"]',
                    },
                    model: { type: "string" },
                    restoreOnly: { type: "boolean" },
                    chartRedraw: { type: "boolean" },
                  },
            additionalProperties: true,
          },
        },
      },
    };
    if (["createReport", "createPdfTranslation"].includes(entry.operationId)) {
      operation.responses[202] = { description: "작업 생성됨" };
    }
  }
  if ([
    "generateVibeProject",
    "refineVibeProject",
    "generateVibeImage",
    "buildArtifact",
    "saveArtifact",
    "assistCode",
    "buildCodeProject",
    "createWebhook",
    "createGoogleDoc",
    "createNotionPage",
    "generatePhysicsProblems",
    "createCommunityPost",
    "voteCommunityPost",
    "createCommunityComment",
  ].includes(entry.operationId)) {
    operation.requestBody = {
      required: entry.operationId !== "voteCommunityPost",
      content: {
        "application/json": {
          schema: { type: "object", additionalProperties: true },
        },
      },
    };
  }
  if (["countWords", "calculateStatistics", "calculateRegression", "convertUnit", "convertEquationNotation", "renderGraph"].includes(entry.operationId)) {
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
    };
  }
  if (entry.operationId === "analyzeTable") {
    operation.requestBody = {
      required: true,
      content: {
        "multipart/form-data": {
          schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } },
        },
      },
    };
  }
  if (entry.operationId === "uploadGoogleDriveFile") {
    operation.requestBody = {
      required: true,
      content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } } } },
    };
  }
  if (entry.operationId === "createFileChatMessage") {
    operation.requestBody = {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            properties: {
              message: { type: "string", maxLength: 8000 },
              messages: { type: "string", description: "최근 대화 JSON 배열" },
              model: { type: "string" },
              files: { type: "array", items: { type: "string", format: "binary" }, maxItems: 6 },
            },
            additionalProperties: true,
          },
        },
      },
    };
    operation.responses[200] = {
      description: "UTF-8 텍스트 스트림",
      content: { "text/plain": { schema: { type: "string" } } },
    };
  }
  if (entry.operationId === "streamJobEvents") {
    operation.responses[200] = {
      description: "SSE 진행 스트림",
      content: { "text/event-stream": { schema: { type: "string" } } },
    };
  }
  if (["downloadJob", "downloadFile", "convertDocxToHwpx", "convertHwpxEquations"].includes(entry.operationId)) {
    operation.responses[200] = {
      description: "생성 파일",
      content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
    };
  }
  if (entry.operationId === "renderGraph") {
    operation.responses[200] = {
      description: "PNG 또는 SVG 그래프",
      content: {
        "image/png": { schema: { type: "string", format: "binary" } },
        "image/svg+xml": { schema: { type: "string" } },
      },
    };
  }
  return operation;
}

function routeTag(apiPath) {
  if (apiPath.includes("/jobs")) return "Jobs";
  if (apiPath.includes("/files")) return "Files";
  if (apiPath.includes("/reports")) return "Reports";
  if (apiPath.includes("/pdf-translations")) return "Translations";
  if (apiPath.includes("/conversions")) return "Conversions";
  if (apiPath.includes("/documents")) return "Documents";
  if (apiPath.includes("/tools")) return "Tools";
  if (apiPath.includes("/integrations") || apiPath.includes("/webhook")) return "Integrations";
  if (apiPath.includes("/studios")) return "Studios";
  if (apiPath.includes("/file-chat")) return "File Chat";
  if (apiPath.includes("/knowledge")) return "Knowledge";
  if (apiPath.includes("/community")) return "Community";
  return "Account";
}

function buildOpenApiDocument({ serverUrl = "https://quilolab.com" } = {}) {
  const paths = {
    "/api/catalog": {
      get: {
        operationId: "listFeatures",
        summary: "Quilo 전체 기능 카탈로그",
        tags: ["Catalog"],
        security: [],
        responses: { 200: { description: "기능 목록" } },
      },
    },
    "/api/catalog/{id}": {
      get: {
        operationId: "getFeature",
        summary: "Quilo 기능 상세",
        tags: ["Catalog"],
        security: [],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "기능 상세" }, 404: { $ref: "#/components/responses/NotFound" } },
      },
    },
  };
  for (const entry of API_V1_ROUTES) {
    const method = entry.method.toLowerCase();
    paths[entry.path] ||= {};
    paths[entry.path][method] = operationFor(entry);
  }

  const errorSchema = {
    type: "object",
    required: ["error", "code", "requestId"],
    properties: {
      error: { type: "string" },
      code: { type: "string" },
      requestId: { type: "string" },
      requiredScope: { type: "string" },
    },
  };
  const errorResponse = (description) => ({
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Quilo API",
      version: "1.0.0",
      description: "Quilo 기능 카탈로그와 범위 제한 Bearer API입니다. 웹과 동일한 권한, 과금, 파일 보관 정책을 적용합니다.",
    },
    servers: [{ url: String(serverUrl).replace(/\/+$/, "") }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Quilo access token",
          description: "developers.html에서 발급한 quilo_... 토큰",
          "x-scopes": SCOPE_DEFINITIONS,
        },
      },
      schemas: { ApiError: errorSchema },
      responses: {
        Unauthorized: errorResponse("토큰이 없거나 유효하지 않음"),
        Forbidden: errorResponse("필요한 scope 또는 사용자 권한이 없음"),
        NotFound: errorResponse("리소스를 찾을 수 없음"),
      },
    },
  };
}

function createOpenApiRouter() {
  const router = express.Router();
  router.get("/", (req, res) => {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0];
    const host = req.get("host") || "quilolab.com";
    res.json(buildOpenApiDocument({ serverUrl: `${forwardedProto}://${host}` }));
  });
  return router;
}

module.exports = { buildOpenApiDocument, createOpenApiRouter };
