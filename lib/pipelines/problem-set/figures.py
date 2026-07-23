#!/usr/bin/env python3
"""problem-set 그림 추출기 (PyMuPDF/fitz 기반).

소스 교재 PDF 에서 문제에 딸린 **그림·도표·그래프**를 잘라내 PNG 로 돌려준다.
poppler 의존 없이 fitz 만 쓴다(Render 에 이미 설치됨 — requirements.txt pymupdf).

표준 입력으로 JSON 한 덩어리를 받고, 표준 출력으로 JSON 한 덩어리를 돌려준다.

입력(JSON):
  {"mode":"detect", "pdf_b64":"...", "dpi":200, "max_candidates":28}
  {"mode":"crop",   "pdf_b64":"...", "dpi":220,
   "regions":[{"id":"f1","page":5,"bbox":[0.55,0.40,0.95,0.52]}, ...]}

  - detect: 페이지마다 (a)내장 래스터 이미지 배치, (b)벡터 도형 군집을
    후보 그림으로 잡아 잘라낸다. 흰 여백은 자동 트림.
  - crop: Claude 가 준 "페이지 + 분수 bbox(L,T,R,B, 0~1)" 영역만 잘라낸다(폴백).

출력(JSON):
  detect → {"ok":true, "page_count":N, "candidates":[{id,page,kind,bbox,w,h,png_base64}, ...]}
  crop   → {"ok":true, "crops":[{id,page,w,h,png_base64}, ...]}
  실패   → {"ok":false, "error":"..."}

png_base64 는 트림된 PNG 의 base64. 좌표(bbox)는 detect 에선 PDF pt 단위,
crop 입력에선 분수(0~1)다.
"""
import sys, json, base64, io


def _eprint(*a):
    print(*a, file=sys.stderr, flush=True)


def trim_png(png_bytes, pad=6):
    """흰 여백 제거. (png_bytes, (w,h)) 반환. PIL 없으면 원본 그대로."""
    try:
        from PIL import Image, ImageChops
    except Exception:
        return png_bytes, None
    try:
        im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        diff = ImageChops.difference(im, bg)
        bbox = diff.getbbox()
        if not bbox:
            return png_bytes, im.size
        l, t, r, b = bbox
        l = max(0, l - pad)
        t = max(0, t - pad)
        r = min(im.width, r + pad)
        b = min(im.height, b + pad)
        im2 = im.crop((l, t, r, b))
        # 과도하게 큰 그림은 긴 변 1600px 로 다운스케일(임베드·전송 비용 방어).
        max_side = 1600
        if max(im2.size) > max_side:
            scale = max_side / float(max(im2.size))
            im2 = im2.resize(
                (max(1, int(im2.width * scale)), max(1, int(im2.height * scale)))
            )
        out = io.BytesIO()
        im2.save(out, "PNG")
        return out.getvalue(), im2.size
    except Exception:
        return png_bytes, None


def render_clip(page, rect, dpi):
    """page 의 rect(pt) 영역을 dpi 로 렌더 → 트림된 PNG bytes, (w,h)."""
    import fitz

    zoom = max(0.5, min(4.0, dpi / 72.0))
    mat = fitz.Matrix(zoom, zoom)
    # clip 은 페이지 경계 안으로 클램프.
    clip = rect & page.rect
    if clip.is_empty or clip.is_infinite:
        return None, None
    pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
    png = pix.tobytes("png")
    return trim_png(png)


def _rect(fitz, r):
    try:
        rr = fitz.Rect(r)
    except Exception:
        return None
    if rr.is_empty or rr.is_infinite:
        return None
    return rr


def cluster_rects(fitz, rects, gap=14, max_in=500):
    """가까운 사각형들을 합쳐 군집 bbox 리스트로. O(n^2) 다중 패스(개수 제한)."""
    boxes = [fitz.Rect(r) for r in rects[:max_in]]
    changed = True
    guard = 0
    while changed and guard < 40:
        guard += 1
        changed = False
        used = [False] * len(boxes)
        out = []
        for i in range(len(boxes)):
            if used[i]:
                continue
            a = fitz.Rect(boxes[i])
            for j in range(i + 1, len(boxes)):
                if used[j]:
                    continue
                b = boxes[j]
                ax = fitz.Rect(a.x0 - gap, a.y0 - gap, a.x1 + gap, a.y1 + gap)
                if ax.intersects(b):
                    a |= b
                    used[j] = True
                    changed = True
            used[i] = True
            out.append(a)
        boxes = out
    return boxes


def overlap_ratio(a, b):
    inter = a & b
    if inter.is_empty:
        return 0.0
    ia = inter.width * inter.height
    sa = min(a.width * a.height, b.width * b.height) or 1.0
    return ia / sa


def detect(doc, dpi=200, max_candidates=28):
    import fitz

    candidates = []
    cid = 0
    for pno in range(len(doc)):
        if len(candidates) >= max_candidates:
            break
        page = doc[pno]
        pr = page.rect
        page_area = (pr.width * pr.height) or 1.0
        seen = []

        # (a) 내장 래스터 이미지 배치 — 정확한 rect, 깔끔한 크롭.
        try:
            infos = page.get_image_info(xrefs=True)
        except Exception:
            infos = []
        for info in infos:
            r = _rect(fitz, info.get("bbox"))
            if r is None:
                continue
            area = r.width * r.height
            if area < 0.02 * page_area or area > 0.95 * page_area:
                continue
            if r.width < 36 or r.height < 36:
                continue
            png, size = render_clip(page, r, dpi)
            if not png:
                continue
            cid += 1
            w, h = (size or (0, 0))
            candidates.append(
                {
                    "id": f"F{cid}",
                    "page": pno + 1,
                    "kind": "raster",
                    "bbox": [round(r.x0, 1), round(r.y0, 1), round(r.x1, 1), round(r.y1, 1)],
                    "w": w,
                    "h": h,
                    "png_base64": base64.b64encode(png).decode(),
                }
            )
            seen.append(r)
            if len(candidates) >= max_candidates:
                break

        if len(candidates) >= max_candidates:
            break

        # (b) 벡터 도형 군집 — 그래프·도식·구조식 등 선 그림.
        rects = []
        try:
            for d in page.get_drawings():
                r = _rect(fitz, d.get("rect"))
                if r is None:
                    continue
                if r.width < 3 and r.height < 3:
                    continue
                rects.append(r)
        except Exception:
            rects = []
        if not rects:
            continue
        for grp in cluster_rects(fitz, rects):
            area = grp.width * grp.height
            if area < 0.03 * page_area or area > 0.95 * page_area:
                continue
            if grp.width < 48 or grp.height < 48:
                continue
            # 이미 잡은 래스터와 크게 겹치면 중복 → 스킵.
            if any(overlap_ratio(grp, sr) > 0.6 for sr in seen):
                continue
            png, size = render_clip(page, grp, dpi)
            if not png:
                continue
            cid += 1
            w, h = (size or (0, 0))
            # 트림 후 너무 작아진(거의 빈) 군집은 버림.
            if w and h and (w < 40 or h < 40):
                continue
            candidates.append(
                {
                    "id": f"F{cid}",
                    "page": pno + 1,
                    "kind": "vector",
                    "bbox": [round(grp.x0, 1), round(grp.y0, 1), round(grp.x1, 1), round(grp.y1, 1)],
                    "w": w,
                    "h": h,
                    "png_base64": base64.b64encode(png).decode(),
                }
            )
            seen.append(grp)
            if len(candidates) >= max_candidates:
                break
    return candidates


def crop(doc, regions, dpi=220):
    import fitz

    crops = []
    n = len(doc)
    for reg in regions or []:
        try:
            pno = int(reg.get("page", 1)) - 1
        except Exception:
            continue
        if pno < 0 or pno >= n:
            continue
        bbox = reg.get("bbox") or []
        if len(bbox) != 4:
            continue
        page = doc[pno]
        pr = page.rect
        try:
            L, T, R, B = [float(x) for x in bbox]
        except Exception:
            continue
        # 분수(0~1)로 해석. 살짝 뒤집힌 좌표도 보정.
        x0 = pr.x0 + min(L, R) * pr.width
        x1 = pr.x0 + max(L, R) * pr.width
        y0 = pr.y0 + min(T, B) * pr.height
        y1 = pr.y0 + max(T, B) * pr.height
        rect = fitz.Rect(x0, y0, x1, y1)
        if rect.width < 8 or rect.height < 8:
            continue
        png, size = render_clip(page, rect, dpi)
        if not png:
            continue
        w, h = (size or (0, 0))
        crops.append(
            {
                "id": str(reg.get("id") or f"c{pno + 1}"),
                "page": pno + 1,
                "w": w,
                "h": h,
                "png_base64": base64.b64encode(png).decode(),
            }
        )
    return crops


def prepare(doc, chunk_pages=4, dpi=200, max_candidates=8):
    """소스 PDF 를 chunk_pages 쪽씩 잘라 sub-PDF + 각 chunk 의 후보 그림을 만든다.

    병렬 추출용: 각 chunk 의 EXTRACT 호출은 자기 sub-PDF 만 보므로 범위 스코핑이
    보장된다. 후보 id 는 chunk 별로 네임스페이스("c{ci}f{k}")해 충돌을 막고,
    global_page = chunk.start + (local_page-1) 로 원본 전체에서의 페이지를 같이 준다.
    """
    import fitz

    n = doc.page_count
    K = max(1, int(chunk_pages or 4))
    chunks = []
    ci = 0
    for from0 in range(0, n, K):
        to0 = min(from0 + K - 1, n - 1)  # 0-based 포함, 마지막 chunk 클램프
        start = from0 + 1  # 1-based 전역
        end = to0 + 1
        sub = fitz.open()
        sub.insert_pdf(doc, from_page=from0, to_page=to0)  # 0-based 양끝 포함
        cands = detect(sub, dpi=dpi, max_candidates=max_candidates)
        for k, c in enumerate(cands, 1):
            c["id"] = f"c{ci}f{k}"  # detect 의 F{n} 을 네임스페이스로 덮어씀
            c["global_page"] = start + (int(c.get("page", 1)) - 1)
        chunks.append(
            {
                "index": ci,
                "start": start,
                "end": end,
                "pdf_b64": base64.b64encode(sub.tobytes()).decode(),
                "candidates": cands,
            }
        )
        sub.close()
        ci += 1
    return n, K, chunks


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"입력 JSON 파싱 실패: {e}"}))
        return
    try:
        import fitz  # noqa: F401
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"PyMuPDF(fitz) 임포트 실패: {e}"}))
        return

    pdf_b64 = payload.get("pdf_b64") or ""
    if not pdf_b64:
        print(json.dumps({"ok": False, "error": "pdf_b64 가 비었습니다."}))
        return
    try:
        import fitz

        pdf_bytes = base64.b64decode(pdf_b64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"PDF 열기 실패: {e}"}))
        return

    mode = payload.get("mode", "detect")
    try:
        if mode == "detect":
            dpi = int(payload.get("dpi", 200) or 200)
            maxc = int(payload.get("max_candidates", 28) or 28)
            cands = detect(doc, dpi=dpi, max_candidates=maxc)
            print(
                json.dumps(
                    {"ok": True, "page_count": len(doc), "candidates": cands}
                )
            )
        elif mode == "crop":
            dpi = int(payload.get("dpi", 220) or 220)
            crops = crop(doc, payload.get("regions") or [], dpi=dpi)
            print(json.dumps({"ok": True, "crops": crops}))
        elif mode == "prepare":
            dpi = int(payload.get("dpi", 200) or 200)
            cp = int(payload.get("chunk_pages", 4) or 4)
            maxc = int(payload.get("max_candidates", 8) or 8)
            n, K, chunks = prepare(doc, chunk_pages=cp, dpi=dpi, max_candidates=maxc)
            print(
                json.dumps(
                    {"ok": True, "page_count": n, "chunk_pages": K, "chunks": chunks}
                )
            )
        else:
            print(json.dumps({"ok": False, "error": f"알 수 없는 mode: {mode}"}))
    except Exception as e:
        import traceback

        _eprint(traceback.format_exc())
        print(json.dumps({"ok": False, "error": f"{mode} 실패: {e}"}))
    finally:
        try:
            doc.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
