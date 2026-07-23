from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from quilo import AsyncQuiloClient, QuiloApiError, QuiloClient  # noqa: E402


class Handler(BaseHTTPRequestHandler):
    job_reads = 0

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def json_response(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self) -> bool:
        if self.headers.get("Authorization") == "Bearer quilo_test":
            return True
        self.json_response(401, {"error": "bad token", "code": "INVALID_ACCESS_TOKEN", "requestId": "req_test"})
        return False

    def do_GET(self) -> None:
        if self.path.startswith("/api/catalog"):
            self.json_response(200, {"features": [{"id": "pdf-translate", "execution": "remote"}]})
            return
        if not self.authorized():
            return
        if self.path == "/api/v1/account":
            self.json_response(200, {"user": {"id": "user-1"}, "credits": 10})
        elif self.path == "/api/v1/jobs":
            self.json_response(200, {"jobs": [{"id": "job-1", "status": "completed"}]})
        elif self.path == "/api/v1/jobs/job-1":
            Handler.job_reads += 1
            status = "running" if Handler.job_reads == 1 else "completed"
            self.json_response(200, {"job": {"id": "job-1", "status": status}})
        elif self.path == "/api/v1/jobs/job-1/download":
            payload = b"%PDF-test"
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == "/api/v1/studios/vibe/config":
            self.json_response(200, {"defaultModel": "claude-sonnet-5"})
        elif self.path == "/api/v1/studios/artifacts/models":
            self.json_response(200, {"models": ["auto"]})
        elif self.path == "/api/v1/studios/artifacts":
            self.json_response(200, {"artifacts": [{"slug": "mine"}]})
        elif self.path == "/api/v1/studios/artifacts/mine":
            self.json_response(200, {"slug": "mine", "html": "<!doctype html></html>"})
        elif self.path == "/api/v1/studios/code/models":
            self.json_response(200, {"models": [{"id": "free"}]})
        elif self.path == "/api/v1/file-chat/access":
            self.json_response(200, {"allowed": True})
        elif self.path == "/api/v1/knowledge/lab":
            self.json_response(200, {"entries": [{"id": "entry-1"}]})
        elif self.path == "/api/v1/knowledge/lab/entry-1":
            self.json_response(200, {"id": "entry-1", "title": "API"})
        elif self.path == "/api/v1/community/posts":
            self.json_response(200, {"posts": [{"id": "post-1"}]})
        elif self.path == "/api/v1/tools/units":
            self.json_response(200, {"categories": {"length": ["m", "km"]}})
        elif self.path == "/api/v1/integrations":
            self.json_response(200, {"integrations": {"google": {"connected": True}}})
        elif self.path == "/api/v1/integrations/byok":
            self.json_response(200, {"keys": [{"provider": "openai", "hint": "1234"}]})
        elif self.path.startswith("/api/v1/integrations/dropbox/link?"):
            self.json_response(200, {"url": "https://dropbox.example/file"})
        elif self.path.startswith("/api/v1/integrations/google-drive/files?"):
            self.json_response(200, {"files": [{"id": "drive-py"}]})
        else:
            self.json_response(404, {"error": "not found", "code": "NOT_FOUND", "requestId": "req_test"})

    def do_POST(self) -> None:
        if not self.authorized():
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        if self.path == "/api/v1/jobs/job-1/email":
            self.json_response(200, {"ok": True, "sent": True})
            return
        if not self.headers.get("Content-Type", "").startswith("multipart/form-data; boundary="):
            if self.headers.get("Content-Type") == "application/json":
                if self.path == "/api/v1/studios/vibe/generate":
                    self.json_response(200, {"result": {"title": "프로젝트"}})
                elif self.path == "/api/v1/studios/vibe/image":
                    self.json_response(200, {"dataUrl": "data:image/png;base64,eA=="})
                elif self.path == "/api/v1/studios/artifacts/build":
                    self.json_response(200, {"html": "<!doctype html></html>"})
                elif self.path == "/api/v1/studios/artifacts":
                    self.json_response(200, {"slug": "mine", "url": "/p/mine"})
                elif self.path == "/api/v1/studios/code/assist":
                    self.json_response(200, {"answer": "수정 코드"})
                elif self.path == "/api/v1/studios/code/projects":
                    self.json_response(200, {"files": [{"path": "index.html", "content": "ok"}]})
                elif self.path == "/api/v1/studios/physics/generate":
                    self.json_response(200, {"result": {"title": "물리"}})
                elif self.path == "/api/v1/community/posts":
                    self.json_response(200, {"ok": True, "post": {"id": "post-2"}})
                elif self.path == "/api/v1/tools/word-count":
                    self.json_response(200, {"characters": 3})
                elif self.path == "/api/v1/tools/statistics":
                    self.json_response(200, {"statistics": {"mean": 2}})
                elif self.path == "/api/v1/tools/regression":
                    self.json_response(200, {"regression": {"slope": 2}})
                elif self.path == "/api/v1/tools/units/convert":
                    self.json_response(200, {"result": 1000})
                elif self.path == "/api/v1/tools/equations/convert":
                    self.json_response(200, {"result": "x²"})
                elif self.path == "/api/v1/tools/graphs":
                    payload = b"<svg/>"
                    self.send_response(200)
                    self.send_header("Content-Type", "image/svg+xml")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                elif self.path == "/api/v1/integrations/google-docs":
                    self.json_response(201, {"document": {"id": "doc-py"}})
                elif self.path == "/api/v1/integrations/notion/pages":
                    self.json_response(201, {"page": {"id": "notion-py"}})
                else:
                    self.json_response(404, {"error": "not found"})
                return
            self.json_response(400, {"error": "multipart required"})
            return
        if self.path == "/api/v1/pdf-translations/estimate":
            if b'filename="input.pdf"' not in body:
                self.json_response(400, {"error": "missing pdf"})
                return
            self.json_response(200, {"pages": 2, "mode": "inplace"})
        elif self.path == "/api/v1/pdf-translations":
            self.json_response(200, {"jobId": "job-1"})
        elif self.path == "/api/v1/conversions/docx-to-hwpx":
            payload = b"PK-hwpx"
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == "/api/v1/documents/pdf/analyze":
            self.json_response(200, {"analysis": {"page_count": 3}})
        elif self.path == "/api/v1/documents/images/ocr":
            self.json_response(200, {"text": "추출한 글"})
        elif self.path == "/api/v1/documents/hwpx/equations":
            payload = b"PK-equations"
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.hancom.hwpx")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == "/api/v1/tools/tables/analyze":
            self.json_response(200, {"analysis": {"sheetCount": 1}})
        elif self.path == "/api/v1/file-chat/messages":
            payload = "파일 답변".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == "/api/v1/integrations/google-drive/files":
            self.json_response(201, {"file": {"id": "uploaded-py"}})
        else:
            self.json_response(404, {"error": "not found", "code": "NOT_FOUND", "requestId": "req_test"})

    def do_DELETE(self) -> None:
        if not self.authorized():
            return
        if self.path == "/api/v1/studios/artifacts/mine":
            self.json_response(200, {"ok": True})
        else:
            self.json_response(404, {"error": "not found", "code": "NOT_FOUND", "requestId": "req_test"})


class QuiloClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self) -> None:
        Handler.job_reads = 0
        self.client = QuiloClient(api_key="quilo_test", base_url=self.base_url, timeout=3)

    def test_public_catalog_and_authenticated_account(self) -> None:
        self.assertEqual(self.client.features("pdf")[0]["id"], "pdf-translate")
        self.assertEqual(self.client.account()["credits"], 10)

    def test_api_errors_preserve_code_and_request_id(self) -> None:
        client = QuiloClient(api_key="wrong", base_url=self.base_url, timeout=3)
        with self.assertRaises(QuiloApiError) as raised:
            client.account()
        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(raised.exception.code, "INVALID_ACCESS_TOKEN")
        self.assertEqual(raised.exception.request_id, "req_test")

    def test_pdf_estimate_translate_wait_and_download(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.pdf"
            source.write_bytes(b"%PDF-input")
            estimate = self.client.pdf.estimate(source)
            self.assertEqual(estimate["pages"], 2)
            job = self.client.pdf.translate(source)
            self.assertEqual(job.id, "job-1")
            completed = self.client.jobs.wait(job.id, timeout=2, poll_interval=0.01)
            self.assertEqual(completed.status, "completed")
            output = self.client.jobs.download(job.id, Path(directory) / "output.pdf")
            self.assertEqual(output.read_bytes(), b"%PDF-test")

    def test_docx_conversion_writes_binary_result(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.docx"
            output = Path(directory) / "output.hwpx"
            source.write_bytes(b"PK-docx")
            result = self.client.conversions.docx_to_hwpx(source, output)
            self.assertEqual(result.read_bytes(), b"PK-hwpx")

    def test_document_analysis_ocr_and_equation_conversion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "input.pdf"
            image = root / "input.png"
            hwpx = root / "input.hwpx"
            pdf.write_bytes(b"%PDF-input")
            image.write_bytes(b"PNG-input")
            hwpx.write_bytes(b"PK-hwpx")
            self.assertEqual(self.client.documents.analyze_pdf(pdf)["analysis"]["page_count"], 3)
            self.assertEqual(self.client.documents.ocr_image(image)["text"], "추출한 글")
            output = self.client.documents.convert_hwpx_equations(hwpx, root / "output.hwpx")
            self.assertEqual(output.read_bytes(), b"PK-equations")

    def test_calculation_tools_resource(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            table = root / "table.csv"
            table.write_text("x,y\n1,3\n2,5\n", encoding="utf-8")
            self.assertEqual(self.client.tools.word_count("abc")["characters"], 3)
            self.assertEqual(self.client.tools.statistics([1, 2, 3])["statistics"]["mean"], 2)
            self.assertEqual(self.client.tools.regression([1, 2], [3, 5])["regression"]["slope"], 2)
            self.assertEqual(self.client.tools.convert_unit(1, "km", "m", "length")["result"], 1000)
            self.assertEqual(self.client.tools.convert_equation("x^2")["result"], "x²")
            self.assertEqual(self.client.tools.analyze_table(table)["analysis"]["sheetCount"], 1)
            graph = self.client.tools.render_graph({"y": [1, 2], "format": "svg"}, root / "graph.svg")
            self.assertEqual(graph.read_bytes(), b"<svg/>")

    def test_async_client_wraps_resources(self) -> None:
        async def run() -> None:
            client = AsyncQuiloClient(api_key="quilo_test", base_url=self.base_url, timeout=3)
            features = await client.features("pdf")
            jobs = await client.jobs.list()
            self.assertEqual(features[0]["id"], "pdf-translate")
            self.assertEqual(jobs[0].id, "job-1")

        asyncio.run(run())

    def test_studio_chat_knowledge_and_community_resources(self) -> None:
        self.assertEqual(self.client.studios.vibe_config()["defaultModel"], "claude-sonnet-5")
        self.assertEqual(self.client.studios.generate_vibe("앱")["result"]["title"], "프로젝트")
        self.assertTrue(self.client.studios.generate_vibe_image("개념 이미지")["dataUrl"].startswith("data:image"))
        self.assertEqual(self.client.studios.generate_physics("역학")["result"]["title"], "물리")
        self.assertTrue(self.client.file_chat.access()["allowed"])
        self.assertEqual(self.client.file_chat.message("질문"), "파일 답변")
        self.assertEqual(self.client.knowledge.lab()[0]["id"], "entry-1")
        self.assertEqual(self.client.knowledge.lab_entry("entry-1")["title"], "API")
        self.assertEqual(self.client.community.posts()[0]["id"], "post-1")
        self.assertEqual(self.client.community.create_post("제목", "본문")["post"]["id"], "post-2")
        self.assertEqual(self.client.studios.artifact_models()["models"][0], "auto")
        self.assertIn("doctype", self.client.studios.build_artifact("앱")["html"])
        self.assertEqual(self.client.studios.artifacts()[0]["slug"], "mine")
        self.assertEqual(self.client.studios.save_artifact("앱", "<!doctype html></html>")["slug"], "mine")
        self.assertEqual(self.client.studios.artifact("mine")["slug"], "mine")
        self.assertTrue(self.client.studios.delete_artifact("mine")["ok"])
        self.assertEqual(self.client.studios.assist_code("고쳐줘")["answer"], "수정 코드")
        self.assertEqual(self.client.studios.build_code_project("앱")["files"][0]["path"], "index.html")

    def test_result_email_and_cloud_integration_resources(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "result.pdf"
            source.write_bytes(b"%PDF-cloud")
            self.assertTrue(self.client.jobs.email("job-1")["sent"])
            self.assertTrue(self.client.integrations.status()["integrations"]["google"]["connected"])
            self.assertEqual(self.client.integrations.byok_status()["keys"][0]["hint"], "1234")
            self.assertTrue(self.client.integrations.dropbox_link("/result.pdf")["url"].startswith("https:"))
            self.assertEqual(self.client.integrations.google_drive_files()[0]["id"], "drive-py")
            self.assertEqual(self.client.integrations.upload_google_drive(source)["file"]["id"], "uploaded-py")
            self.assertEqual(self.client.integrations.create_google_doc("제목", "본문")["document"]["id"], "doc-py")
            self.assertEqual(self.client.integrations.create_notion_page("제목", "본문")["page"]["id"], "notion-py")


if __name__ == "__main__":
    unittest.main()
