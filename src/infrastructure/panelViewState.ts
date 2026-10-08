import { libraryIdentity } from "./library";
export interface PanelView {
  search: string;
  filter: string;
}
export function panelViewKey(
  projectId: string,
  environmentId: string,
  panel: string,
): string {
  return `automade:panel:v1:${encodeURIComponent(libraryIdentity() || "local-owner")}:${projectId}:${environmentId}:${panel}`;
}
export function readPanelView(
  projectId: string,
  environmentId: string,
  panel: string,
): PanelView {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(panelViewKey(projectId, environmentId, panel)) ||
        "null",
    );
    if (raw && typeof raw === "object") {
      const item = raw as Record<string, unknown>;
      return {
        search:
          typeof item.search === "string" ? item.search.slice(0, 200) : "",
        filter:
          typeof item.filter === "string" &&
          ["all", "favorites", "recent"].includes(item.filter)
            ? item.filter
            : "all",
      };
    }
  } catch {
    /* The view can be restored through its URL when browser storage is unavailable. */
  }
  return { search: "", filter: "all" };
}
