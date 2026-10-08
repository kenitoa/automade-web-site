export const STUDIO_PANELS = [
  "blocks",
  "pages",
  "layers",
  "assets",
  "projects",
  "quality",
  "output",
  "operations",
] as const;
export interface StudioContext {
  projectId: string;
  environmentId: string;
  pageId: string;
  blockId: string;
  panel: string;
  inspectorOpen: boolean;
  search?: string;
  filter?: string;
}
const identifier = (value: string | null) =>
  value && /^[a-zA-Z0-9_-]{1,120}$/.test(value) ? value : "";
export function readStudioContext(search: string): StudioContext | null {
  const query = new URLSearchParams(search),
    projectId = identifier(query.get("studioProject"));
  if (!projectId) return null;
  const panel = query.get("studioPanel") || "blocks";
  return {
    projectId,
    environmentId: identifier(query.get("studioEnvironment")),
    pageId: identifier(query.get("studioPage")),
    blockId: identifier(query.get("studioBlock")),
    panel: STUDIO_PANELS.includes(panel as (typeof STUDIO_PANELS)[number])
      ? panel
      : "blocks",
    inspectorOpen: query.get("studioInspector") === "1",
    ...(query.get("studioSearch")
      ? { search: query.get("studioSearch")!.slice(0, 200) }
      : {}),
    ...(["favorites", "recent"].includes(query.get("studioFilter") || "")
      ? { filter: query.get("studioFilter")! }
      : {}),
  };
}
export function studioContextSearch(context: StudioContext): string {
  const params = new URLSearchParams({
    studioProject: context.projectId,
    studioPanel: context.panel,
  });
  for (const [key, value] of [
    ["studioEnvironment", context.environmentId],
    ["studioPage", context.pageId],
    ["studioBlock", context.blockId],
    ["studioInspector", context.inspectorOpen ? "1" : ""],
    ["studioSearch", context.search || ""],
    [
      "studioFilter",
      context.filter && context.filter !== "all" ? context.filter : "",
    ],
  ])
    if (value) params.set(key!, value);
  return "?" + params.toString();
}
export function contextStorageKey(identity: string): string {
  return `automade:view:v1:${encodeURIComponent(identity || "local-owner")}`;
}
