function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CATEGORY_LABELS = {
  bug: "버그",
  feature: "기능 제안",
  account: "계정",
  billing: "결제",
  "report-quality": "보고서 품질",
  data: "데이터",
  format: "문서형식",
  school: "학교도입",
  // 기존 Account Center에서 들어오는 값을 계속 정확한 분류로 보관한다.
  "data-processing": "데이터",
  other: "기타",
};

function categoryLabel(category) {
  return CATEGORY_LABELS[category] || CATEGORY_LABELS.other;
}

function buildFeedbackText(feedback) {
  const lines = [
    `분류: ${categoryLabel(feedback.category)} (${feedback.category})`,
    `제목: ${feedback.title}`,
    `사용자: ${feedback.userName || "-"}${feedback.studentId ? ` / ${feedback.studentId}` : ""}`,
    `연락처: ${feedback.contactEmail || "-"}`,
    `페이지: ${feedback.pageUrl || "-"}`,
    `시간: ${feedback.submittedAt}`,
    "",
    "내용:",
    feedback.message,
  ];
  return lines.join("\n");
}

function buildFeedbackHtml(feedback) {
  const rows = [
    ["분류", `${categoryLabel(feedback.category)} (${feedback.category})`],
    ["제목", feedback.title],
    [
      "사용자",
      `${feedback.userName || "-"}${feedback.studentId ? ` / ${feedback.studentId}` : ""}`,
    ],
    ["연락처", feedback.contactEmail || "-"],
    ["페이지", feedback.pageUrl || "-"],
    ["시간", feedback.submittedAt],
  ];
  return `<!doctype html>
<html lang="ko">
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif; color:#1f2937; line-height:1.55;">
    <h2 style="margin:0 0 16px;">Quilo 고객센터 문의</h2>
    <table style="border-collapse:collapse; width:100%; max-width:720px;">
      ${rows
        .map(
          ([label, value]) => `<tr>
        <th style="width:110px; padding:8px 10px; border:1px solid #d9e0ea; background:#f8fafc; text-align:left;">${escapeHtml(label)}</th>
        <td style="padding:8px 10px; border:1px solid #d9e0ea;">${escapeHtml(value)}</td>
      </tr>`,
        )
        .join("")}
    </table>
    <h3 style="margin:22px 0 8px;">내용</h3>
    <div style="white-space:pre-wrap; padding:14px; border:1px solid #d9e0ea; border-radius:8px; background:#f8fafc;">${escapeHtml(feedback.message)}</div>
  </body>
</html>`;
}

async function sendFeedbackEmail(feedback) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = resolveFeedbackRecipient(process.env);
  const from = process.env.FEEDBACK_EMAIL_FROM || process.env.RESEND_FROM;

  if (!apiKey || !to || !from) {
    return { sent: false, reason: "not_configured" };
  }

  const subjectTitle = String(feedback.title || "").slice(0, 80);
  const subject = `[Quilo 고객센터 · ${categoryLabel(feedback.category)}] ${subjectTitle}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text: buildFeedbackText(feedback),
      html: buildFeedbackHtml(feedback),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      sent: false,
      reason: `resend_${response.status}`,
      detail: detail.slice(0, 500),
    };
  }

  const data = await response.json().catch(() => ({}));
  return { sent: true, id: data.id || null };
}

function resolveFeedbackRecipient(env = process.env) {
  return env.SUPPORT_EMAIL_TO || "fakeminjun7321@quilolab.com";
}

module.exports = {
  CATEGORY_LABELS,
  categoryLabel,
  resolveFeedbackRecipient,
  sendFeedbackEmail,
};
