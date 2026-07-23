let pendingSnapshot = null;

async function readJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}

/**
 * Loads the role/capability snapshot once per page. The header, Account Center,
 * and generation confirmation all consume the same promise so opening Quilo
 * does not issue the same entitlement requests three times.
 */
export function loadEntitlementsSnapshot(options = {}) {
  if (!pendingSnapshot || options.force) {
    pendingSnapshot = Promise.all([
      readJson("/api/subscriptions/me"),
      readJson("/api/me/beta"),
    ]).then(([subscription, beta]) => ({ subscription, beta }));
  }
  return pendingSnapshot;
}

export function clearEntitlementsSnapshot() {
  pendingSnapshot = null;
}
