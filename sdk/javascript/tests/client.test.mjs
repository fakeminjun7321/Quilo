import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Quilo, QuiloError } from "../src/index.js";

async function startServer() {
  let jobReads = 0;
  const server = http.createServer((req, res) => {
    const json = (status, body) => {
      const data = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
      res.end(data);
    };
    if (req.url.startsWith("/api/catalog")) return json(200, { features: [{ id: "pdf-translate", execution: "remote" }] });
    if (req.headers.authorization !== "Bearer quilo_test") return json(401, { error: "bad token", code: "INVALID_ACCESS_TOKEN", requestId: "req_js" });
    if (req.method === "GET" && req.url === "/api/v1/account") return json(200, { credits: 12 });
    if (req.method === "GET" && req.url === "/api/v1/studios/vibe/config") return json(200, { defaultModel: "claude-sonnet-5" });
    if (req.method === "GET" && req.url === "/api/v1/studios/artifacts/models") return json(200, { models: ["auto"] });
    if (req.method === "GET" && req.url === "/api/v1/studios/artifacts") return json(200, { artifacts: [{ slug: "mine" }] });
    if (req.method === "GET" && req.url === "/api/v1/studios/artifacts/mine") return json(200, { slug: "mine", html: "<!doctype html></html>" });
    if (req.method === "GET" && req.url === "/api/v1/studios/code/models") return json(200, { models: [{ id: "free" }] });
    if (req.method === "GET" && req.url === "/api/v1/file-chat/access") return json(200, { allowed: true });
    if (req.method === "GET" && req.url === "/api/v1/knowledge/lab") return json(200, { entries: [{ id: "entry-js" }] });
    if (req.method === "GET" && req.url === "/api/v1/community/posts") return json(200, { posts: [{ id: "post-js" }] });
    if (req.method === "GET" && req.url === "/api/v1/tools/units") return json(200, { categories: { length: ["m", "km"] } });
    if (req.method === "GET" && req.url === "/api/v1/integrations") return json(200, { integrations: { google: { connected: true } } });
    if (req.method === "GET" && req.url === "/api/v1/integrations/byok") return json(200, { keys: [{ provider: "openai", hint: "1234" }] });
    if (req.method === "GET" && req.url.startsWith("/api/v1/integrations/dropbox/link?")) return json(200, { url: "https://dropbox.example/file" });
    if (req.method === "GET" && req.url.startsWith("/api/v1/integrations/google-drive/files?")) return json(200, { files: [{ id: "drive-js" }] });
    if (req.method === "GET" && req.url === "/api/v1/jobs/job-js") {
      jobReads += 1;
      return json(200, { job: { id: "job-js", status: jobReads > 1 ? "completed" : "running" } });
    }
    if (req.method === "GET" && req.url === "/api/v1/jobs/job-js/download") {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end("%PDF-js");
    }
    req.resume();
    req.on("end", () => {
      if (req.url === "/api/v1/pdf-translations/estimate") return json(200, { pages: 4, mode: "inplace" });
      if (req.url === "/api/v1/pdf-translations") return json(200, { jobId: "job-js" });
      if (req.url === "/api/v1/conversions/docx-to-hwpx") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end("PK-js");
      }
      if (req.url === "/api/v1/documents/pdf/analyze") return json(200, { analysis: { page_count: 3 } });
      if (req.url === "/api/v1/documents/images/ocr") return json(200, { text: "추출한 글" });
      if (req.url === "/api/v1/documents/hwpx/equations") {
        res.writeHead(200, { "content-type": "application/vnd.hancom.hwpx" });
        return res.end("PK-equations");
      }
      if (req.url === "/api/v1/tools/word-count") return json(200, { characters: 3 });
      if (req.url === "/api/v1/tools/statistics") return json(200, { statistics: { mean: 2 } });
      if (req.url === "/api/v1/tools/regression") return json(200, { regression: { slope: 2 } });
      if (req.url === "/api/v1/tools/units/convert") return json(200, { result: 1000 });
      if (req.url === "/api/v1/tools/equations/convert") return json(200, { result: "x²" });
      if (req.url === "/api/v1/tools/tables/analyze") return json(200, { analysis: { sheetCount: 1 } });
      if (req.url === "/api/v1/tools/graphs") {
        res.writeHead(200, { "content-type": "image/svg+xml" });
        return res.end("<svg/>");
      }
      if (req.url === "/api/v1/studios/vibe/generate") return json(200, { result: { title: "JS 프로젝트" } });
      if (req.url === "/api/v1/studios/vibe/image") return json(200, { dataUrl: "data:image/png;base64,eA==" });
      if (req.url === "/api/v1/studios/artifacts/build") return json(200, { html: "<!doctype html></html>" });
      if (req.url === "/api/v1/studios/artifacts") return json(200, { slug: "mine", url: "/p/mine" });
      if (req.url === "/api/v1/studios/artifacts/mine" && req.method === "DELETE") return json(200, { ok: true });
      if (req.url === "/api/v1/studios/code/assist") return json(200, { answer: "수정 코드" });
      if (req.url === "/api/v1/studios/code/projects") return json(200, { files: [{ path: "index.html", content: "ok" }] });
      if (req.url === "/api/v1/studios/physics/generate") return json(200, { result: { title: "JS 물리" } });
      if (req.url === "/api/v1/file-chat/messages") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end("JS 파일 답변");
      }
      if (req.url === "/api/v1/community/posts") return json(200, { ok: true, post: { id: "post-new" } });
      if (req.url === "/api/v1/jobs/job-js/email") return json(200, { ok: true, sent: true });
      if (req.url === "/api/v1/integrations/google-drive/files") return json(201, { file: { id: "uploaded-js" } });
      if (req.url === "/api/v1/integrations/google-docs") return json(201, { document: { id: "doc-js" } });
      if (req.url === "/api/v1/integrations/notion/pages") return json(201, { page: { id: "notion-js" } });
      return json(404, { error: "not found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("JavaScript SDK calls catalog, PDF, jobs, download, and conversion APIs", async (t) => {
  const server = await startServer();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quilo-js-test-"));
  t.after(async () => {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const pdf = path.join(root, "input.pdf");
  const docx = path.join(root, "input.docx");
  const hwpx = path.join(root, "input.hwpx");
  const image = path.join(root, "input.png");
  await fs.writeFile(pdf, "%PDF-input");
  await fs.writeFile(docx, "PK-docx");
  await fs.writeFile(hwpx, "PK-hwpx");
  await fs.writeFile(image, "PNG-image");
  const client = new Quilo({ apiKey: "quilo_test", baseUrl: `http://127.0.0.1:${server.address().port}` });

  assert.equal((await client.features("pdf"))[0].id, "pdf-translate");
  assert.equal((await client.account()).credits, 12);
  assert.equal((await client.pdf.estimate(pdf)).pages, 4);
  const job = await client.pdf.translate(pdf);
  assert.equal(job.id, "job-js");
  assert.equal((await client.jobs.wait(job.id, { timeoutMs: 1000, pollIntervalMs: 10 })).status, "completed");
  const downloaded = await client.jobs.download(job.id, path.join(root, "out.pdf"));
  assert.equal(await fs.readFile(downloaded, "utf8"), "%PDF-js");
  const converted = await client.conversions.docxToHwpx(docx, path.join(root, "out.hwpx"));
  assert.equal(await fs.readFile(converted, "utf8"), "PK-js");
  assert.equal((await client.documents.analyzePdf(pdf)).analysis.page_count, 3);
  assert.equal((await client.documents.ocrImage(image)).text, "추출한 글");
  const equations = await client.documents.convertHwpxEquations(hwpx, path.join(root, "equations.hwpx"));
  assert.equal(await fs.readFile(equations, "utf8"), "PK-equations");
  assert.equal((await client.tools.wordCount("abc")).characters, 3);
  assert.equal((await client.tools.statistics([1, 2, 3])).statistics.mean, 2);
  assert.equal((await client.tools.regression([1, 2], [3, 5])).regression.slope, 2);
  assert.equal((await client.tools.convertUnit(1, "km", "m", "length")).result, 1000);
  assert.equal((await client.tools.convertEquation("x^2")).result, "x²");
  assert.equal((await client.tools.analyzeTable(pdf)).analysis.sheetCount, 1);
  const graph = await client.tools.renderGraph({ y: [1, 2], format: "svg" }, path.join(root, "graph.svg"));
  assert.equal(await fs.readFile(graph, "utf8"), "<svg/>");
});

test("JavaScript SDK exposes studio, chat, knowledge, and community resources", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = new Quilo({ apiKey: "quilo_test", baseUrl: `http://127.0.0.1:${server.address().port}` });
  assert.equal((await client.studios.vibeConfig()).defaultModel, "claude-sonnet-5");
  assert.equal((await client.studios.generateVibe("앱")).result.title, "JS 프로젝트");
  assert.match((await client.studios.generateVibeImage("개념 이미지")).dataUrl, /^data:image/);
  assert.equal((await client.studios.generatePhysics("역학")).result.title, "JS 물리");
  assert.equal((await client.fileChat.access()).allowed, true);
  assert.equal(await client.fileChat.message("질문"), "JS 파일 답변");
  assert.equal((await client.knowledge.lab())[0].id, "entry-js");
  assert.equal((await client.community.posts())[0].id, "post-js");
  assert.equal((await client.community.createPost({ title: "제목", body: "본문" })).post.id, "post-new");
  assert.equal((await client.studios.artifactModels()).models[0], "auto");
  assert.match((await client.studios.buildArtifact("앱")).html, /doctype/);
  assert.equal((await client.studios.artifacts())[0].slug, "mine");
  assert.equal((await client.studios.saveArtifact({ title: "앱", html: "<!doctype html></html>" })).slug, "mine");
  assert.equal((await client.studios.artifact("mine")).slug, "mine");
  assert.equal((await client.studios.deleteArtifact("mine")).ok, true);
  assert.equal((await client.studios.assistCode("고쳐줘")).answer, "수정 코드");
  assert.equal((await client.studios.buildCodeProject("앱")).files[0].path, "index.html");
});

test("JavaScript SDK exposes result email and cloud integration resources", async (t) => {
  const server = await startServer();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quilo-js-cloud-"));
  t.after(async () => {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "result.pdf");
  await fs.writeFile(file, "%PDF-cloud");
  const client = new Quilo({ apiKey: "quilo_test", baseUrl: `http://127.0.0.1:${server.address().port}` });
  assert.equal((await client.jobs.email("job-js")).sent, true);
  assert.equal((await client.integrations.status()).integrations.google.connected, true);
  assert.equal((await client.integrations.byokStatus()).keys[0].hint, "1234");
  assert.match((await client.integrations.dropboxLink("/result.pdf")).url, /^https:/);
  assert.equal((await client.integrations.googleDriveFiles())[0].id, "drive-js");
  assert.equal((await client.integrations.uploadGoogleDrive(file)).file.id, "uploaded-js");
  assert.equal((await client.integrations.createGoogleDoc("제목", "본문")).document.id, "doc-js");
  assert.equal((await client.integrations.createNotionPage("제목", "본문")).page.id, "notion-js");
});

test("JavaScript SDK preserves API error metadata", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = new Quilo({ apiKey: "wrong", baseUrl: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(client.account(), (error) => {
    assert.ok(error instanceof QuiloError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "INVALID_ACCESS_TOKEN");
    assert.equal(error.requestId, "req_js");
    return true;
  });
});
