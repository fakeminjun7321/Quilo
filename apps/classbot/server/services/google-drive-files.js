import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DRIVE_ID_PREFIX = "gdrive_";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function defaultDependencies() {
  const cloud = require("../../../../lib/cloud/oauth-providers.js");
  const supa = require("../../../../lib/supabase.js");
  return {
    findUserByName: (name) => supa.findUserByName(name),
    findUsersByExactName: async (name) => {
      const raw = String(name || "").trim();
      const client = supa.getClient();
      if (!client || !raw) return [];
      const { data, error } = await client
        .from("users")
        .select("id,name")
        .eq("name", raw)
        .limit(20);
      if (error) throw new Error(`Google Drive 운영 계정 조회 실패: ${error.message}`);
      return (data || []).filter((user) => user?.id && user.name === raw);
    },
    getCloudConnection: (userId, provider) => supa.getCloudConnection(userId, provider),
    decryptToken: (value) => cloud.decryptToken(value),
    getAccessToken: (refreshToken) => cloud.googleAccessToken(refreshToken),
    listDriveFiles: (accessToken, options) => cloud.listDriveFiles(accessToken, options),
    ensureDriveFolder: (accessToken, options) => cloud.ensureDriveFolder(accessToken, options),
    getDriveFile: (accessToken, fileId) => cloud.getDriveFile(accessToken, fileId),
    downloadDriveFile: (accessToken, fileId) => cloud.downloadDriveFile(accessToken, fileId),
    uploadDriveFile: (accessToken, options) => cloud.uploadDriveFile(accessToken, options),
  };
}

function safeIdentifier(value, label) {
  const text = String(value || "").trim();
  if (!text || text.length > 300 || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error(`${label} 설정이 올바르지 않습니다.`);
  }
  return text;
}

function normalizedFile(file) {
  const mimeType = String(file?.mimeType || "").toLowerCase();
  const sizeBytes = Number(file?.size);
  if (!file?.id || !file?.name || !ALLOWED_MIME_TYPES.has(mimeType)) return null;
  if (file.capabilities?.canDownload === false) return null;
  if (Number.isFinite(sizeBytes) && (sizeBytes < 1 || sizeBytes > MAX_FILE_BYTES)) return null;
  return {
    sourceId: String(file.id),
    filename: String(file.name).slice(0, 180),
    alias: String(file.appProperties?.classbotAlias || file.name.replace(/\.[^.]+$/, "")).trim().slice(0, 60),
    description: String(file.appProperties?.classbotDescription || "Google Drive 자료").trim().slice(0, 1000),
    mimeType,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    createdAt: file.createdTime || file.modifiedTime || new Date(0).toISOString(),
    modifiedAt: file.modifiedTime || file.createdTime || new Date(0).toISOString(),
  };
}

function hmac(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export class GoogleDriveFileProvider {
  constructor({ folderId = "", folderName = "Quilo schedule 자료실", ownerUserId = "", secret = "", dependencies } = {}) {
    this.folderId = String(folderId || "").trim();
    this.folderName = String(folderName || "Quilo schedule 자료실").trim().slice(0, 100) || "Quilo schedule 자료실";
    this.ownerUserId = String(ownerUserId || "").trim();
    this.secret = String(secret || "");
    this.dependencies = dependencies || null;
    this.lastError = null;
    this.folderPromise = null;
    this.folderWebViewLink = "";
  }

  get configured() {
    return Boolean(this.ownerUserId && this.secret);
  }

  async resolveOwnerUserId() {
    if (this.ownerUserId) return this.ownerUserId;
    throw new Error("CLASSBOT_GOOGLE_DRIVE_OWNER_USER_ID가 필요합니다.");
  }

  isManagedId(value) {
    return String(value || "").startsWith(DRIVE_ID_PREFIX);
  }

  encodeId(sourceId) {
    const id = safeIdentifier(sourceId, "Google Drive 파일");
    const encoded = Buffer.from(id, "utf8").toString("base64url");
    return `${DRIVE_ID_PREFIX}${encoded}.${hmac(`${this.ownerUserId}:${this.folderId}:${id}`, this.secret)}`;
  }

  decodeId(value) {
    const [encoded, supplied, extra] = String(value || "").slice(DRIVE_ID_PREFIX.length).split(".");
    if (!this.isManagedId(value) || !encoded || !supplied || extra) throw new Error("올바르지 않은 Google Drive 자료입니다.");
    let sourceId;
    try {
      sourceId = safeIdentifier(Buffer.from(encoded, "base64url").toString("utf8"), "Google Drive 파일");
    } catch {
      throw new Error("올바르지 않은 Google Drive 자료입니다.");
    }
    const expected = hmac(`${this.ownerUserId}:${this.folderId}:${sourceId}`, this.secret);
    const left = Buffer.from(supplied);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      throw new Error("올바르지 않은 Google Drive 자료입니다.");
    }
    return sourceId;
  }

  async context() {
    const dependencies = this.dependencies || defaultDependencies();
    const ownerUserId = await this.resolveOwnerUserId(dependencies);
    const connection = await dependencies.getCloudConnection(ownerUserId, "google");
    if (!connection?.refresh_token) throw new Error("Quilo 관리자 계정에 Google Drive 연결이 없습니다.");
    const refreshToken = dependencies.decryptToken(connection.refresh_token);
    const accessToken = await dependencies.getAccessToken(refreshToken);
    if (!this.folderId) {
      if (!this.folderPromise) {
        this.folderPromise = dependencies.ensureDriveFolder(accessToken, { name: this.folderName })
          .then((folder) => {
            this.folderId = safeIdentifier(folder?.id, "Google Drive 폴더");
            this.folderWebViewLink = String(folder?.webViewLink || "");
            return this.folderId;
          })
          .catch((error) => {
            this.folderPromise = null;
            throw error;
          });
      }
      await this.folderPromise;
    } else {
      safeIdentifier(this.folderId, "Google Drive 폴더");
      if (!this.folderWebViewLink) {
        const folder = await dependencies.getDriveFile(accessToken, this.folderId);
        this.folderWebViewLink = String(folder?.webViewLink || "");
      }
    }
    return { accessToken, dependencies };
  }

  toClassbotFile(file) {
    const clean = normalizedFile(file);
    if (!clean) return null;
    return {
      id: this.encodeId(clean.sourceId),
      member_id: null,
      alias: clean.alias,
      filename: clean.filename,
      description: clean.description,
      mime_type: clean.mimeType,
      size_bytes: clean.sizeBytes,
      provider: "google_drive",
      status: "active",
      created_at: clean.createdAt,
      updated_at: clean.modifiedAt,
    };
  }

  async listFiles() {
    if (!this.configured) return [];
    try {
      const { accessToken, dependencies } = await this.context();
      const files = await dependencies.listDriveFiles(accessToken, {
        folderId: this.folderId,
        pageSize: 100,
      });
      this.lastError = null;
      return files.map((file) => this.toClassbotFile(file)).filter(Boolean);
    } catch (error) {
      this.lastError = error;
      throw error;
    }
  }

  async getFile(managedId) {
    if (!this.configured) return null;
    const { accessToken, dependencies } = await this.context();
    const sourceId = this.decodeId(managedId);
    const file = await dependencies.getDriveFile(accessToken, sourceId);
    if (!Array.isArray(file?.parents) || !file.parents.includes(this.folderId)) {
      throw new Error("설정된 Quilo schedule 자료실 밖의 파일에는 접근할 수 없습니다.");
    }
    const mapped = this.toClassbotFile(file);
    if (!mapped) throw new Error("PDF 또는 지원되는 이미지 파일만 열 수 있습니다.");
    return mapped;
  }

  async downloadFile(managedId) {
    const { accessToken, dependencies } = await this.context();
    const sourceId = this.decodeId(managedId);
    const file = await dependencies.getDriveFile(accessToken, sourceId);
    if (!Array.isArray(file?.parents) || !file.parents.includes(this.folderId)) {
      throw new Error("설정된 Quilo schedule 자료실 밖의 파일에는 접근할 수 없습니다.");
    }
    if (!this.toClassbotFile(file)) throw new Error("PDF 또는 지원되는 이미지 파일만 열 수 있습니다.");
    const downloaded = await dependencies.downloadDriveFile(accessToken, sourceId);
    if (!Buffer.isBuffer(downloaded?.buffer) || downloaded.buffer.length < 1 || downloaded.buffer.length > MAX_FILE_BYTES) {
      throw new Error("Google Drive 자료는 20MB 이하만 열 수 있습니다.");
    }
    return Buffer.from(downloaded.buffer);
  }

  async uploadFile(input, body) {
    if (!this.configured) throw new Error("Google Drive 자료실 운영 계정이 설정되지 않았습니다.");
    if (!Buffer.isBuffer(body) || body.length < 1 || body.length > MAX_FILE_BYTES) {
      throw new Error("Google Drive 자료는 20MB 이하여야 합니다.");
    }
    const mimeType = String(input?.mime_type || "").toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new Error("PDF 또는 지원되는 이미지 파일만 올릴 수 있습니다.");
    const { accessToken, dependencies } = await this.context();
    const uploaded = await dependencies.uploadDriveFile(accessToken, {
      name: String(input.filename || "Quilo 자료").slice(0, 180),
      mimeType,
      buffer: body,
      folderId: this.folderId,
      appProperties: {
        quiloOrigin: "classbot",
        classbotAlias: String(input.alias || "").slice(0, 60),
        classbotDescription: String(input.description || "").slice(0, 1000),
      },
    });
    const file = this.toClassbotFile(uploaded);
    if (!file) throw new Error("Google Drive 업로드 결과를 확인할 수 없습니다.");
    return file;
  }

  async status() {
    if (!this.ownerUserId) return { configured: false, connected: false, reason: "owner_user_missing", connect_url: null };
    if (!this.secret) return { configured: false, connected: false, reason: "signing_secret_missing", connect_url: null };
    const links = { connect_url: "/api/cloud/google/connect" };
    try {
      await this.context();
      return {
        configured: true,
        connected: true,
        folder_name: this.folderName,
        folder_url: this.folderWebViewLink || null,
        ...links,
      };
    } catch {
      return { configured: true, connected: false, reason: "google_drive_unavailable", ...links };
    }
  }
}

export class CompositeFileStore {
  constructor(store, googleDrive, { logger = console } = {}) {
    this.store = store;
    this.googleDrive = googleDrive;
    this.logger = logger;
  }

  async listFiles(options = {}) {
    const primary = await this.store.listFiles(options);
    if (!this.googleDrive?.configured || (options.status && options.status !== "active")) return primary;
    try {
      const drive = await this.googleDrive.listFiles();
      return [...primary, ...drive]
        .filter((file) => options.all || file.member_id == null || (options.targetMemberId && file.member_id === options.targetMemberId))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } catch (error) {
      this.logger.warn?.(`[classbot-drive] ${String(error?.message || error).slice(0, 200)}`);
      return primary;
    }
  }

  getFile(fileId) {
    return this.googleDrive?.isManagedId(fileId) ? this.googleDrive.getFile(fileId) : this.store.getFile(fileId);
  }

  downloadFile(fileId) {
    return this.googleDrive?.isManagedId(fileId) ? this.googleDrive.downloadFile(fileId) : this.store.downloadFile(fileId);
  }

  createFile(...args) {
    const [input, body, actor] = args;
    if (!input?.member_id && this.googleDrive?.configured) {
      return this.googleDrive.uploadFile(input, body).catch((error) => {
        this.logger.warn?.(`[classbot-drive] upload fallback: ${String(error?.message || error).slice(0, 200)}`);
        return this.store.createFile(input, body, actor);
      });
    }
    return this.store.createFile(input, body, actor);
  }

  updateFile(fileId, ...args) {
    if (this.googleDrive?.isManagedId(fileId)) {
      throw Object.assign(new Error("Google Drive 자료의 이름과 설명은 Drive에서 관리해 주세요."), { status: 409 });
    }
    return this.store.updateFile(fileId, ...args);
  }

  deleteFile(fileId, ...args) {
    if (this.googleDrive?.isManagedId(fileId)) {
      throw Object.assign(new Error("Google Drive 자료 삭제는 Drive에서 직접 진행해 주세요."), { status: 409 });
    }
    return this.store.deleteFile(fileId, ...args);
  }
}

export function createGoogleDriveFileProvider(config, dependencies) {
  return new GoogleDriveFileProvider({
    folderId: config?.googleDrive?.folderId,
    folderName: config?.googleDrive?.folderName,
    ownerUserId: config?.googleDrive?.ownerUserId,
    secret: config?.sessionSecret,
    dependencies,
  });
}
