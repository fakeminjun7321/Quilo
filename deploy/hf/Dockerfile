# Hugging Face Spaces (Docker SDK) — PDF 통번역 독립 서버.
# 번역 엔진(lib/pipelines/pdf-translate)만 담은 경량 배포. 메인 보고서 앱과 별개.
# Keep the human-readable tag for update tooling, but make builds immutable.
FROM node:20-bookworm@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5

# 시스템 의존성: python(pymupdf/pdf2docx venv), 폰트, Tectonic 다운로드 도구,
# LibreOffice Writer. LibreOffice는 명시적 재조판 렌더러일 때만 실행된다.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip fontconfig curl ca-certificates xz-utils \
      libreoffice-writer fonts-noto-cjk fonts-nanum \
    && rm -rf /var/lib/apt/lists/*

# node:20 이미지엔 이미 uid 1000 'node' 사용자가 있으므로 그걸 그대로 사용
# (HF Spaces 권장 uid 1000과 동일 — 새로 useradd 하면 UID 충돌로 빌드 실패).
RUN install -d -o node -g node /home/node/app /home/node/.cache
USER node
ENV HOME=/home/node \
    PATH=/home/node/app/bin:/home/node/.local/bin:/usr/local/bin:$PATH \
    NODE_ENV=production \
    PORT=7860 \
    TRANSLATE_PORT=7860 \
    LIBREOFFICE_BIN=/usr/bin/libreoffice \
    XDG_CACHE_HOME=/home/node/.cache
WORKDIR /home/node/app

# 앱 + 엔진 복사(빌드 컨텍스트는 build-staging.sh 가 만든 최소 세트).
COPY --chown=node:node . /home/node/app

# Install only the dependency graph recorded in package-lock.json. Dependency
# lifecycle scripts are disabled; the two repository-owned setup steps run
# explicitly below so an npm package cannot execute code during installation.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

RUN python3 -m venv .venv \
    && .venv/bin/python -m pip install \
      --disable-pip-version-check \
      --require-hashes \
      --only-binary=:all: \
      --no-deps \
      -r requirements.txt \
    && .venv/bin/python scripts/check-python-runtime.py \
    && bash scripts/install-tectonic.sh \
    && command -v tectonic >/dev/null \
    && tectonic --version

EXPOSE 7860
CMD ["node", "translate-server.js"]
