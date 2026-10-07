import type { Project } from "./types";
/** Remove editor-only content before serializing any public document. */
export function publicProject(input: Project): Project {
  const p = structuredClone(input);
  p.pages = p.pages.filter((page) => page.published);
  const pageIds = new Set(p.pages.map((page) => page.id));
  const candidates = p.blocks.filter(
    (b) => !b.hidden && (b.pageId === "*" || pageIds.has(b.pageId)),
  );
  const allowed = new Set(candidates.map((b) => b.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of candidates)
      if (allowed.has(b.id) && b.parentId && !allowed.has(b.parentId)) {
        allowed.delete(b.id);
        changed = true;
      }
  }
  p.blocks = candidates.filter((b) => allowed.has(b.id));
  const assets = new Set([p.settings.faviconAssetId]);
  for (const b of p.blocks) {
    assets.add(b.props.assetId);
    for (const item of b.props.items)
      if (item.imageId) assets.add(item.imageId);
  }
  p.assets = p.assets.filter((a) => assets.has(a.id));
  return p;
}
