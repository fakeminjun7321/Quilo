"use strict";

// 생성은 성공했지만 취소·검증·결제 확정이 실패한 경우 외부 저장소에 남은
// 미공개 산출물을 보상 삭제한다. 실패한 식별자는 job에 그대로 남겨 재시도할 수 있다.
async function cleanupExternalGeneratedArtifacts(job, {
  supa,
  cloudProviders,
  dropbox,
} = {}) {
  const userId = job?.userInfo?.id;
  const failures = [];
  if (!job || !userId) return { ok: true, failures };

  const supabaseFileIds = new Set();
  if (job.fileId) supabaseFileIds.add(job.fileId);
  for (const entry of job.files || []) {
    if (entry?.fileId) supabaseFileIds.add(entry.fileId);
  }
  if (supa?.isEnabled?.()) {
    for (const fileId of supabaseFileIds) {
      try {
        await supa.deleteReportFile(userId, fileId);
        if (job.fileId === fileId) job.fileId = null;
        for (const entry of job.files || []) {
          if (entry?.fileId === fileId) entry.fileId = null;
        }
      } catch (error) {
        failures.push({ provider: "supabase", id: fileId, error });
      }
    }
  }

  if (job.googleDriveFileId && supa?.isEnabled?.() && cloudProviders) {
    try {
      const connection = await supa.getCloudConnection(userId, "google");
      if (!connection?.refresh_token) throw new Error("Google 연결 토큰이 없습니다.");
      const refreshToken = cloudProviders.decryptToken(connection.refresh_token);
      const accessToken = await cloudProviders.googleAccessToken(refreshToken);
      await cloudProviders.deleteDriveFile(accessToken, job.googleDriveFileId);
      job.googleDriveFileId = "";
      job.googleDriveUrl = "";
    } catch (error) {
      failures.push({ provider: "google", id: job.googleDriveFileId, error });
    }
  }

  const dropboxTarget = job.dropboxFileId || job.dropboxFilePath;
  if (dropboxTarget && supa?.isEnabled?.() && dropbox) {
    try {
      const connection = await supa.getCloudConnection(userId, "dropbox");
      if (!connection?.refresh_token) throw new Error("Dropbox 연결 토큰이 없습니다.");
      const refreshToken = dropbox.decryptToken(connection.refresh_token);
      const { access_token: accessToken } = await dropbox.refreshAccessToken(refreshToken);
      if (!accessToken) throw new Error("Dropbox access token을 받지 못했습니다.");
      await dropbox.deleteFile({ accessToken, path: dropboxTarget });
      job.dropboxFileId = "";
      job.dropboxFilePath = "";
      if (job.cloudProvider === "dropbox") job.cloudProvider = "";
    } catch (error) {
      failures.push({ provider: "dropbox", id: dropboxTarget, error });
    }
  }

  return { ok: failures.length === 0, failures };
}

module.exports = { cleanupExternalGeneratedArtifacts };
