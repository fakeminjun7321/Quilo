"use strict";

async function retryOperation(operation, {
  attempts = 3,
  baseDelayMs = 100,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts && baseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

// settle 응답이 유실됐을 수 있으므로 같은 jobId/금액으로 먼저 재시도한다. 여전히
// 실패하면 멱등 refund의 상태로 DB 커밋 여부를 판별한다.
async function settleDurableReservation(supa, jobId, spent, options) {
  let settlementError;
  try {
    const result = await retryOperation(
      () => supa.settleCreditReservation(jobId, spent),
      options,
    );
    return { status: "settled", recovered: result.changed === false, ...result };
  } catch (error) {
    settlementError = error;
  }

  try {
    const rollback = await retryOperation(
      () => supa.refundCreditReservation(jobId),
      options,
    );
    if (rollback.alreadySettled || rollback.status === "settled") {
      return {
        status: "settled",
        recovered: true,
        settlementError,
        ...rollback,
      };
    }
    if (rollback.refunded || rollback.status === "refunded") {
      return {
        status: "refunded",
        recovered: true,
        settlementError,
        ...rollback,
      };
    }
    throw new Error(`예상하지 못한 예약 상태: ${rollback.status || "unknown"}`);
  } catch (refundError) {
    const error = new AggregateError(
      [settlementError, refundError],
      "크레딧 정산 상태를 확인하지 못했습니다.",
    );
    error.code = "CREDIT_SETTLEMENT_UNCERTAIN";
    error.settlementError = settlementError;
    error.refundError = refundError;
    throw error;
  }
}

async function refundDurableReservation(supa, jobId, options) {
  const result = await retryOperation(
    () => supa.refundCreditReservation(jobId),
    options,
  );
  return {
    status: result.alreadySettled || result.status === "settled"
      ? "settled"
      : "refunded",
    ...result,
  };
}

module.exports = {
  refundDurableReservation,
  retryOperation,
  settleDurableReservation,
};
