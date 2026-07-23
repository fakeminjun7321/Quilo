(async () => {
  const nodes = document.querySelectorAll("[data-site-version]");
  if (!nodes.length) return;
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (!res.ok) throw new Error("version fetch failed");
    const info = await res.json();
    const release = info && (info.releaseVersion || info.version);
    if (!release) throw new Error("version missing");
    const version = info.shortCommit
      ? `v${release} · ${info.shortCommit}`
      : `v${release}`;
    nodes.forEach((node) => {
      node.textContent = version;
      node.title = info.commit ? `commit ${info.commit}` : "현재 배포 버전";
    });
  } catch (_) {
    nodes.forEach((node) => {
      node.textContent = "버전 확인 불가";
    });
  }
})();
