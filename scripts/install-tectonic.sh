#!/usr/bin/env bash
# Render 빌드용: Tectonic(self-contained XeLaTeX) 정적 바이너리를 bin/ 에 설치한다.
# - 재조판(re-typeset) PDF 번역(Claude→LaTeX→Tectonic→PDF)에 필요.
# - npm postinstall에서도 설치 실패 시 non-zero로 끝내 배포 단계에서 드러나게 한다.
# - PATH 에 이미 있으면(brew 등) 건너뜀.
# - 첫 컴파일 때 TeX 패키지를 받아 캐시하므로 런타임 네트워크가 필요하다.
set -euo pipefail
VER="0.15.0"
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if command -v tectonic >/dev/null 2>&1 && [ "${TRUST_SYSTEM_TECTONIC:-0}" = "1" ]; then
  echo "tectonic already on PATH — skip"
  exit 0
fi

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64)   ASSET="tectonic-${VER}-x86_64-unknown-linux-musl.tar.gz" ;;
  Linux-aarch64)  ASSET="tectonic-${VER}-aarch64-unknown-linux-musl.tar.gz" ;;
  Darwin-arm64)   ASSET="tectonic-${VER}-aarch64-apple-darwin.tar.gz" ;;
  Darwin-x86_64)  ASSET="tectonic-${VER}-x86_64-apple-darwin.tar.gz" ;;
  *) echo "ERROR: no tectonic prebuilt for $OS-$ARCH" >&2; exit 1 ;;
esac
URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VER}/${ASSET}"
case "$ASSET" in
  tectonic-0.15.0-x86_64-unknown-linux-musl.tar.gz) SHA256="dfb82876f2986862996e564fa507a9e576e0c1e3bee63c2c1bd677c2543e6407" ;;
  tectonic-0.15.0-aarch64-unknown-linux-musl.tar.gz) SHA256="1f59f9fb8eb65e8ba18658fc9016767e7d3e12488ded8b8fffa34254e51ce42c" ;;
  tectonic-0.15.0-aarch64-apple-darwin.tar.gz) SHA256="24bd46566fa30d41101848405e9cbc4645edb92d8f857c9d21262174fb70cd33" ;;
  tectonic-0.15.0-x86_64-apple-darwin.tar.gz) SHA256="dd42576eaa4c0df58c243dd78b7b864d9deb405ffdfcdadd1b79a31faceab747" ;;
  *) echo "missing checksum for $ASSET" >&2; exit 1 ;;
esac

mkdir -p bin
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "downloading tectonic ${VER} ($ASSET)..."
ARCHIVE="$TMP/$ASSET"
if curl -fsSL --max-time 120 -o "$ARCHIVE" "$URL"; then
  ACTUAL="$(sha256_file "$ARCHIVE")"
  if [ "$ACTUAL" != "$SHA256" ]; then
    echo "ERROR: tectonic checksum mismatch for $ASSET" >&2
    echo "expected $SHA256" >&2
    echo "actual   $ACTUAL" >&2
    exit 1
  fi
  tar xzf "$ARCHIVE" -C bin tectonic
  chmod +x bin/tectonic
  echo "tectonic installed → bin/tectonic"
else
  echo "ERROR: tectonic download/extract failed — re-typeset PDF will be unavailable" >&2
  exit 1
fi
