import type { Project } from "./types";
import { isRecordPublished, publicContentRecord } from "./cms";
import { projectBlockDefinition } from "./blockRegistry";
/** Remove editor-only content before serializing any public document. */
export function publicProject(input: Project): Project {
  return publishedProject(input, false);
}
/** Call only after server authentication. Hidden/unpublished/editor data stays excluded. */
export function memberProject(input: Project): Project {
  return publishedProject(input, true);
}
function publishedProject(input: Project, member: boolean): Project {
  const p = structuredClone(input);
  const allowDueSchedule = !input.featurePins?.some(
    (pin) => pin.packageId === "automade.content",
  );
  p.pages = p.pages.filter((page) => page.published);
  const pageIds = new Set(
    p.pages
      .filter((page) => member || page.access !== "members")
      .map((page) => page.id),
  );
  if (!member)
    p.pages = p.pages.map((page) =>
      page.access === "members"
        ? {
            ...page,
            description: "회원 전용 페이지입니다.",
            seo: {
              title: `${page.title} · ${p.name}`,
              description: "회원 전용 페이지입니다.",
              imageAssetId: "",
              noIndex: true,
            },
            translations: undefined,
          }
        : page,
    );
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
  p.blocks = candidates
    .filter((b) => allowed.has(b.id))
    .map(
      (block) =>
        projectBlockDefinition(input, block)?.publicProjection(
          block,
          input,
          member,
        ) ?? block,
    );
  // Studio briefs, review notes, saved sections and draft records never enter public HTML/ZIP.
  delete p.extensions;
  delete p.settings.brief;
  if (p.collections)
    p.collections = p.collections.map((c) => ({
      ...c,
      schema: c.schema?.filter((field) => field.public),
      records:
        member || c.access !== "members"
          ? c.records
              .filter((r) => isRecordPublished(r, undefined, allowDueSchedule))
              .map((record) => publicContentRecord(c, record, input, member))
              .slice(0, c.queryMode === "server" ? 20 : undefined)
          : [],
    }));
  const assets = new Set([p.settings.faviconAssetId]);
  for (const page of p.pages)
    if (page.seo?.imageAssetId) assets.add(page.seo.imageAssetId);
  for (const collection of input.collections ?? [])
    if (member || collection.access !== "members")
      for (const record of collection.records
        .filter((item) => isRecordPublished(item, undefined, allowDueSchedule))
        .map((item) => publicContentRecord(collection, item, input, member))) {
        if (record.imageId) assets.add(record.imageId);
        for (const field of collection.schema ?? [])
          if (field.public && field.type === "image") {
            const value = record.values?.[field.id];
            if (typeof value === "string") assets.add(value);
            for (const translation of Object.values(
              record.translations ?? {},
            )) {
              const value = translation?.values?.[field.id];
              if (typeof value === "string") assets.add(value);
            }
          }
      }
  for (const b of p.blocks) {
    assets.add(b.props.assetId);
    for (const item of b.props.items)
      if (item.imageId) assets.add(item.imageId);
  }
  p.assets = p.assets.filter((a) => assets.has(a.id));
  delete p.components;
  delete p.componentHistory;
  delete p.brandPacks;
  delete p.industryPacks;
  const references = new Set(
    p.blocks.map((block) => block.props.extensionDefinitionId).filter(Boolean),
  );
  p.blockPackages = p.blockPackages
    ?.map((pack) => ({
      ...pack,
      definitions: pack.definitions
        .filter((definition) => references.has(`${pack.id}/${definition.id}`))
        .map((definition) => ({
          ...definition,
          description: "",
          defaults: {},
        })),
    }))
    .filter((pack) => pack.definitions.length > 0);
  p.featurePins = p.featurePins?.filter(
    (pin) =>
      pin.integrity.startsWith("builtin:") ||
      p.blockPackages?.some((pack) => pack.id === pin.packageId),
  );
  return p;
}
