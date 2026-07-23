// Buffer signature 기반 이미지 타입 판별 (docx ImageRun.type 지정용).
// type을 안 주면 docx 라이브러리가 media 파일을 .undefined 확장자로 저장 →
// Word가 "콘텐츠를 읽을 수 없습니다" 오류를 띄움.

function detectImageType(buffer) {
  if (!buffer || buffer.length < 8) return "png";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  // GIF: 47 49 46 38 (GIF8)
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "gif";
  }
  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "bmp";
  }
  // 기본값: PNG (chartjs-node-canvas 출력이 항상 PNG)
  return "png";
}

module.exports = { detectImageType };
