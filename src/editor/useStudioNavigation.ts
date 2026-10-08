import { useEffect, useRef, useState } from "react";
import { api } from "../infrastructure/api";
import { libraryIdentity } from "../infrastructure/library";
import {
  readStudioContext,
  studioContextSearch,
  contextStorageKey,
  type StudioContext,
} from "../infrastructure/studioContext";
import { parseProject } from "../domain/validation";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import { readPanelView } from "../infrastructure/panelViewState";
export function useStudioNavigation(s: StudioState, x: ExpansionState) {
  const initialized = useRef(false),
    pending = useRef<StudioContext | null>(null),
    sequence = useRef(0),
    last = useRef(""),
    replacingHistory = useRef(false);
  const [restoring, setRestoring] = useState(false),
    [error, setError] = useState(""),
    [viewVersion, setViewVersion] = useState(0);
  const latest = useRef({ s, x });
  latest.current = { s, x };
  function context(): StudioContext {
    const { s: studio, x: expansion } = latest.current;
    const view = readStudioContext(window.location.search),
      saved = readPanelView(
        studio.project.id,
        expansion.environmentId,
        studio.panel,
      ),
      same =
        view?.projectId === studio.project.id &&
        view.panel === studio.panel &&
        view.environmentId === expansion.environmentId,
      search = same ? view.search : saved.search,
      filter = same ? view.filter : saved.filter;
    return {
      projectId: studio.project.id,
      environmentId: expansion.environmentId,
      pageId: studio.pageId,
      blockId: studio.selected[0] || "",
      panel: studio.panel,
      inspectorOpen: studio.inspectorOpen,
      ...(search ? { search } : {}),
      ...(filter && filter !== "all" ? { filter } : {}),
    };
  }
  async function navigate(target: StudioContext) {
    const request = ++sequence.current,
      owner = libraryIdentity();
    pending.current = target;
    replacingHistory.current = true;
    last.current = studioContextSearch(target);
    setRestoring(true);
    setError("");
    try {
      const current = latest.current.s;
      if (target.projectId !== current.project.id) {
        const remote = parseProject(
          await api<unknown>(`/api/projects/${target.projectId}`),
        );
        if (request !== sequence.current || owner !== libraryIdentity()) return;
        const local = current.library.find(
          (item) => item.id === target.projectId,
        );
        if (local && local.revision > remote.revision)
          current.openProject(local);
        else await current.openServerProject(remote);
      }
    } catch (e) {
      if (request !== sequence.current) return;
      pending.current = null;
      setRestoring(false);
      setError(e instanceof Error ? e.message : "작업 위치를 다시 확인하세요.");
      window.history.replaceState(
        null,
        "",
        window.location.pathname + studioContextSearch(context()),
      );
    }
  }
  useEffect(() => {
    const pop = () => {
      const target = readStudioContext(window.location.search);
      if (target) void navigate(target);
    };
    window.addEventListener("popstate", pop);
    const view = () => setViewVersion((value) => value + 1);
    window.addEventListener("automade:view-state", view);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("automade:view-state", view);
    };
  }, []);
  useEffect(() => {
    if (!s.loaded || !x.bootstrap) return;
    if (!initialized.current) {
      initialized.current = true;
      let target = readStudioContext(window.location.search);
      if (!target) {
        try {
          target = readStudioContext(
            localStorage.getItem(contextStorageKey(libraryIdentity())) || "",
          );
        } catch {
          setError(
            "작업 위치를 이 기기에 보관하지 못했습니다. 현재 위치 링크는 계속 사용할 수 있습니다.",
          );
        }
      }
      if (target) {
        void navigate(target);
        return;
      }
    }
    const target = pending.current;
    if (
      !target ||
      target.projectId !== s.project.id ||
      x.scope?.projectId !== s.project.id
    )
      return;
    const apply = async () => {
      const request = sequence.current;
      if (target.environmentId && target.environmentId !== x.environmentId) {
        const allowed = x.bootstrap?.environments.some(
          (env) =>
            env.id === target.environmentId &&
            env.projectId === target.projectId,
        );
        if (allowed) await x.selectEnvironment(target.environmentId);
        else
          setError(
            "저장된 환경에 접근할 수 없습니다. 현재 허용된 환경에서 원본을 열었습니다.",
          );
      }
      if (request !== sequence.current) return;
      const current = latest.current.s;
      if (current.project.id !== target.projectId) return;
      const page = current.project.pages.find((p) => p.id === target.pageId);
      if (page) current.setPageId(page.id);
      const block = current.project.blocks.find((b) => b.id === target.blockId);
      current.setSelected(block ? [block.id] : []);
      if (block && block.pageId !== "*") current.setPageId(block.pageId);
      if (target.blockId && !block)
        setError(
          "연결된 항목이 삭제되었거나 이동했습니다. 문서와 현재 내용을 보존했습니다.",
        );
      current.setPanel(target.panel);
      current.setInspectorOpen(target.inspectorOpen || Boolean(block));
      pending.current = null;
      setRestoring(false);
    };
    void apply();
  }, [s.loaded, s.project.id, x.scope?.projectId, x.bootstrap, restoring]);
  useEffect(() => {
    if (
      !initialized.current ||
      restoring ||
      pending.current ||
      !s.loaded ||
      x.busy
    )
      return;
    const next = studioContextSearch(context());
    if (next === last.current && !replacingHistory.current) return;
    const previous = readStudioContext(last.current);
    const major =
      previous &&
      (previous.projectId !== s.project.id ||
        previous.pageId !== s.pageId ||
        previous.environmentId !== x.environmentId ||
        previous.panel !== s.panel);
    window.history[
      major && !replacingHistory.current ? "pushState" : "replaceState"
    ](null, "", window.location.pathname + next);
    last.current = next;
    replacingHistory.current = false;
    try {
      localStorage.setItem(contextStorageKey(libraryIdentity()), next);
    } catch {
      setError(
        "작업 위치 보관 공간을 확인하세요. 현재 링크로 다시 열 수 있습니다.",
      );
    }
  }, [
    s.project.id,
    s.pageId,
    s.selected,
    s.panel,
    s.inspectorOpen,
    x.environmentId,
    x.busy,
    restoring,
    viewVersion,
  ]);
  return {
    restoring,
    error,
    link:
      window.location.origin +
      window.location.pathname +
      studioContextSearch(context()),
    navigate,
  };
}
