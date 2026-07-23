const path = require("path");
const sharp = require("sharp");

// Anthropic rejects oversized image source.base64 payloads. Keep a little
// headroom below 5 MiB because the API validates the encoded field.
const MAX_IMAGE_BASE64_CHARS = parseInt(
  process.env.ANTHROPIC_IMAGE_MAX_BASE64_CHARS || String(4_900_000),
  10,
);
const DEFAULT_MAX_EDGE = parseInt(
  process.env.ANTHROPIC_IMAGE_MAX_EDGE || "2200",
  10,
);
// A request with many images can exceed the API's practical request-size
// ceiling even when each individual image is below 5 MiB. Keep a request-level
// budget and shrink each image more aggressively as the batch grows.
const REQUEST_IMAGE_BASE64_BUDGET = parseInt(
  process.env.ANTHROPIC_REQUEST_IMAGE_MAX_BASE64_CHARS || String(16_000_000),
  10,
);
const MIN_BATCH_IMAGE_BASE64_CHARS = parseInt(
  process.env.ANTHROPIC_MIN_BATCH_IMAGE_BASE64_CHARS || String(250_000),
  10,
);
const MAX_IMAGE_PIXELS = parseInt(
  process.env.ANTHROPIC_IMAGE_MAX_PIXELS || String(48_000_000),
  10,
);

const VISION_MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function base64Length(buffer) {
  const size = Buffer.isBuffer(buffer) ? buffer.length : 0;
  return Math.ceil(size / 3) * 4;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

function inferVisionMime(name = "", mimetype = "") {
  const lowerMime = String(mimetype || "").toLowerCase();
  if (Object.values(VISION_MIME_BY_EXT).includes(lowerMime)) return lowerMime;
  const ext = path.extname(String(name || "")).toLowerCase();
  return VISION_MIME_BY_EXT[ext] || "";
}

function toAnthropicImageBlock(prepared) {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: prepared.mediaType,
      data: prepared.buffer.toString("base64"),
    },
  };
}

function sharpLimited(buffer) {
  return sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS });
}

async function readSafeMetadata(buffer) {
  const meta = await sharpLimited(buffer).metadata();
  const pixels = (meta.width || 0) * (meta.height || 0);
  if (pixels > MAX_IMAGE_PIXELS) {
    throw new Error(
      `이미지 해상도가 너무 큽니다(${meta.width}×${meta.height}, 최대 ${MAX_IMAGE_PIXELS}픽셀).`,
    );
  }
  return meta;
}

function getBatchImageOptions(imageCount) {
  const count = Math.max(1, Number(imageCount) || 1);
  const perImageBudget = Math.floor(REQUEST_IMAGE_BASE64_BUDGET / count);
  const maxBase64Chars = Math.min(
    MAX_IMAGE_BASE64_CHARS,
    Math.max(MIN_BATCH_IMAGE_BASE64_CHARS, perImageBudget),
  );
  const maxEdge =
    count >= 30 ? 700 :
    count >= 20 ? 900 :
    count >= 10 ? 1200 :
    count >= 6 ? 1400 :
    count >= 3 ? 1700 :
    DEFAULT_MAX_EDGE;

  return {
    maxBase64Chars,
    maxEdge,
    forceCompress: count >= 3,
  };
}

async function compressToVisionLimit(buffer, options = {}) {
  const meta = await readSafeMetadata(buffer);
  const maxInputEdge = Math.max(meta.width || 0, meta.height || 0, 1);
  const maxEdge = Math.min(
    Math.max(parseInt(options.maxEdge || DEFAULT_MAX_EDGE, 10), 480),
    DEFAULT_MAX_EDGE,
  );
  const maxBase64Chars = Math.min(
    parseInt(options.maxBase64Chars || MAX_IMAGE_BASE64_CHARS, 10),
    MAX_IMAGE_BASE64_CHARS,
  );
  const initialEdge = Math.min(Math.max(maxEdge, 480), maxInputEdge);
  const edgeSteps = [
    initialEdge,
    2000,
    1800,
    1600,
    1400,
    1200,
    1000,
    850,
    700,
    560,
  ]
    .filter((edge, index, arr) => edge > 0 && edge <= initialEdge && arr.indexOf(edge) === index)
    .sort((a, b) => b - a);
  const qualitySteps = [84, 76, 68, 60, 52, 44, 36];

  let smallest = null;
  for (const edge of edgeSteps) {
    for (const quality of qualitySteps) {
      const out = await sharpLimited(buffer)
        .rotate()
        .flatten({ background: "#ffffff" })
        .resize({
          width: edge,
          height: edge,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (!smallest || out.length < smallest.length) smallest = out;
      if (base64Length(out) <= maxBase64Chars) {
        return { buffer: out, mediaType: "image/jpeg", compressed: true };
      }
    }
  }

  if (smallest && base64Length(smallest) <= maxBase64Chars) {
    return { buffer: smallest, mediaType: "image/jpeg", compressed: true };
  }

  return null;
}

async function prepareImageForAnthropic(file, options = {}) {
  const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.from(file?.buffer || []);
  const name = file?.name || file?.originalname || "image";
  const mediaType = inferVisionMime(name, file?.mimetype);
  const maxBase64Chars = Math.min(
    parseInt(options.maxBase64Chars || MAX_IMAGE_BASE64_CHARS, 10),
    MAX_IMAGE_BASE64_CHARS,
  );
  const forceCompress = !!options.forceCompress;
  if (!mediaType) {
    return {
      ok: false,
      name,
      reason: "지원하지 않는 이미지 형식입니다. png, jpg, jpeg, gif, webp만 지원합니다.",
      originalBytes: buffer.length,
    };
  }

  try {
    await readSafeMetadata(buffer);
  } catch (e) {
    return {
      ok: false,
      name,
      reason: e.message,
      originalBytes: buffer.length,
    };
  }

  if (base64Length(buffer) <= maxBase64Chars && !forceCompress) {
    return {
      ok: true,
      name,
      buffer,
      mediaType,
      originalBytes: buffer.length,
      finalBytes: buffer.length,
      compressed: false,
    };
  }

  try {
    const compressed = await compressToVisionLimit(buffer, {
      maxBase64Chars,
      maxEdge: options.maxEdge,
    });
    if (compressed) {
      return {
        ok: true,
        name,
        buffer: compressed.buffer,
        mediaType: compressed.mediaType,
        originalBytes: buffer.length,
        finalBytes: compressed.buffer.length,
        compressed: true,
      };
    }
  } catch (e) {
    if (base64Length(buffer) <= maxBase64Chars) {
      return {
        ok: true,
        name,
        buffer,
        mediaType,
        originalBytes: buffer.length,
        finalBytes: buffer.length,
        compressed: false,
        warning: `이미지 자동 축소 실패 후 원본 전송: ${e.message}`,
      };
    }
    return {
      ok: false,
      name,
      reason: `이미지 자동 축소 실패: ${e.message}`,
      originalBytes: buffer.length,
    };
  }

  return {
    ok: false,
    name,
    reason: `이미지를 Claude 입력 제한(${formatBytes(Math.floor((maxBase64Chars * 3) / 4))} 내외)까지 줄이지 못했습니다.`,
    originalBytes: buffer.length,
  };
}

function describePreparedImage(prepared) {
  if (!prepared?.ok) {
    return `${prepared?.name || "이미지"} (전송 제외: ${prepared?.reason || "처리 실패"})`;
  }
  if (prepared.compressed) {
    return `${prepared.name} (${formatBytes(prepared.originalBytes)}→${formatBytes(prepared.finalBytes)} 자동 축소)`;
  }
  return `${prepared.name} (${formatBytes(prepared.finalBytes)})`;
}

module.exports = {
  base64Length,
  describePreparedImage,
  formatBytes,
  getBatchImageOptions,
  inferVisionMime,
  prepareImageForAnthropic,
  toAnthropicImageBlock,
};
