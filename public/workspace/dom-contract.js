export function byId(id) {
  return document.getElementById(id);
}

export function required(id) {
  const node = byId(id);
  if (!node) throw new Error(`Quilo DOM contract missing #${id}`);
  return node;
}

export function assertWorkspaceDom() {
  [
    "landingSurface",
    "workspaceSurface",
    "navMenu",
    "loginDd",
    "acctDd",
    "reportsPanel",
    "filesPanel",
  ].forEach(required);
}
