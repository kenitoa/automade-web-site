import { useEffect, useState } from "react";
import { libraryIdentity } from "../infrastructure/library";
import {
  panelViewKey,
  readPanelView,
  type PanelView,
} from "../infrastructure/panelViewState";
export function usePanelView(
  projectId: string,
  environmentId: string,
  panel: string,
) {
  const scope = panelViewKey(projectId, environmentId, panel),
    read = (): PanelView => {
      const query = new URLSearchParams(window.location.search);
      if (
        query.get("studioProject") === projectId &&
        query.get("studioPanel") === panel &&
        (query.get("studioEnvironment") || "") === environmentId
      )
        return {
          search: (query.get("studioSearch") || "").slice(0, 200),
          filter: ["favorites", "recent"].includes(
            query.get("studioFilter") || "",
          )
            ? query.get("studioFilter")!
            : "all",
        };
      return readPanelView(projectId, environmentId, panel);
    },
    [state, setState] = useState(() => ({ scope, value: read() })),
    [error, setError] = useState("");
  const value = state.scope === scope ? state.value : read();
  useEffect(() => {
    setState({ scope, value: read() });
    const restore = () => setState({ scope, value: read() });
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [scope]);
  useEffect(() => {
    if (state.scope !== scope) return;
    try {
      localStorage.setItem(scope, JSON.stringify(state.value));
      setError("");
    } catch {
      setError(
        "이 기기 검색 조건을 보관하지 못했습니다. 현재 위치 링크를 사용할 수 있습니다.",
      );
    }
    const query = new URLSearchParams(window.location.search);
    if (
      query.get("studioProject") !== projectId ||
      query.get("studioPanel") !== panel ||
      (query.get("studioEnvironment") || "") !== environmentId
    )
      return;
    if (state.value.search) query.set("studioSearch", state.value.search);
    else query.delete("studioSearch");
    if (state.value.filter !== "all")
      query.set("studioFilter", state.value.filter);
    else query.delete("studioFilter");
    window.history.replaceState(
      null,
      "",
      window.location.pathname + "?" + query,
    );
    window.dispatchEvent(new Event("automade:view-state"));
  }, [state, scope]);
  const change = (patch: Partial<PanelView>) =>
    setState({ scope, value: { ...value, ...patch } });
  return {
    query: value.search,
    setQuery: (search: string) => change({ search: search.slice(0, 200) }),
    filter: value.filter,
    setFilter: (filter: string) => change({ filter }),
    error,
    identity: libraryIdentity(),
  };
}
