#!/usr/bin/env bash
# Render 빌드용: pandoc 정적 바이너리를 bin/ 에 설치한다.
# - docx → hwpx 변환(pypandoc-hwpx)이 pandoc 을 필요로 한다.
# - 실패해도 빌드는 계속(그 기능만 비활성). PATH 에 이미 있으면(brew 등) 건너뜀.
set -euo pipefail
VER="3.5"
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if command -v pandoc >/dev/null 2>&1 && [ "${TRUST_SYSTEM_PANDOC:-0}" = "1" ]; then
  echo "pandoc already on PATH — skip"
  exit 0
fi

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64)   ASSET="pandoc-${VER}-linux-amd64.tar.gz" ;;
  Linux-aarch64)  ASSET="pandoc-${VER}-linux-arm64.tar.gz" ;;
  *) echo "no pandoc prebuilt for $OS-$ARCH — skip"; exit 0 ;;
esac
URL="https://github.com/jgm/pandoc/releases/download/${VER}/${ASSET}"
case "$ASSET" in
  pandoc-3.5-linux-amd64.tar.gz) SHA256="a46b448ad9e7e5bd898a0606a2a67acbf4bc7714b24dc68931e9a47d7b807015" ;;
  pandoc-3.5-linux-arm64.tar.gz) SHA256="1bd96209bb16a0c0890d1f55eac5d4b6faac975bee20bf703df263f0408f2b51" ;;
  *) echo "missing checksum for $ASSET" >&2; exit 1 ;;
esac

mkdir -p bin
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "downloading pandoc ${VER} ($ASSET)..."
ARCHIVE="$TMP/$ASSET"
if curl -fsSL --max-time 180 -o "$ARCHIVE" "$URL"; then
  ACTUAL="$(sha256_file "$ARCHIVE")"
  if [ "$ACTUAL" != "$SHA256" ]; then
    echo "ERROR: pandoc checksum mismatch for $ASSET" >&2
    echo "expected $SHA256" >&2
    echo "actual   $ACTUAL" >&2
    exit 1
  fi
  tar xzf "$ARCHIVE" -C "$TMP"
  # tar 안 구조: pandoc-<VER>/bin/pandoc
  BIN="$(find "$TMP" -type f -name pandoc | head -1)"
  if [ -n "$BIN" ]; then
    cp "$BIN" bin/pandoc && chmod +x bin/pandoc
    echo "pandoc installed → bin/pandoc"
  else
    echo "WARN: pandoc binary not found in archive — docx→hwpx unavailable"
  fi
else
  echo "WARN: pandoc download failed — docx→hwpx will be unavailable"
fi
