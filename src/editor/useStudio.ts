import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBlock, createProject, uid } from "../domain/catalog";
import {
  commit,
  deleteBlocks,
  duplicateBlocks,
  historyChange,
  redo,
  undo,
  type History,
} from "../domain/commands";
import { inspectProject, parseProject, record } from "../domain/validation";
import type { Asset, BlockType, Issue, Project } from "../domain/types";
import {
  downloadFile,
  importLegacy,
  listProjects,
  persistProject,
  preserveEvidence,
  recoverProjects,
} from "../infrastructure/library";
import { api } from "../infrastructure/api";
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "작업을 처리하지 못했습니다.";
export function useStudio() {
  const [history, setHistory] = useState<History>(() => ({
    past: [],
    present: createProject(),
    future: [],
  }));
  const project = history.present;
  const [library, setLibrary] = useState<Project[]>([]),
    [loaded, setLoaded] = useState(false),
    [ready, setReady] = useState(false),
    [saveState, setSaveState] = useState("불러오는 중"),
    [message, setMessage] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [pageId, setPageId] = useState(project.pages[0]!.id),
    [panel, setPanel] = useState("blocks"),
    [testMode, setTestMode] = useState(false),
    [restore, setRestore] = useState<Project[]>([]);
  const saveSequence = useRef(0),
    autosave = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef({ project, loaded, ready });
  latest.current = { project, loaded, ready };
  const activePage =
    project.pages.find((p) => p.id === pageId) ?? project.pages[0]!;
  const selectedBlock =
    project.blocks.find((b) => b.id === selected[0]) ?? null;
  const issues = useMemo<Issue[]>(() => {
    try {
      return inspectProject(parseProject(project));
    } catch (error) {
      return [{ severity: "error", code: "SCHEMA", message: errorText(error) }];
    }
  }, [project]);
  const apply = useCallback(
    (change: (p: Project) => void) =>
      setHistory((current) =>
        historyChange(current, commit(current.present, change)),
      ),
    [],
  );
  const openProject = useCallback((p: Project) => {
    const previous = latest.current;
    if (
      previous.loaded &&
      JSON.stringify(previous.project) !== JSON.stringify(p)
    ) {
      autosave.current = autosave.current.then(async () => {
        try {
          await persistProject(previous.project);
          if (previous.ready)
            await api("/api/projects", "PUT", previous.project);
        } catch (error) {
          setMessage("이전 프로젝트 저장을 확인하세요: " + errorText(error));
        }
      });
    }
    setHistory({ past: [], present: p, future: [] });
    setPageId(p.pages.find((x) => x.home)!.id);
    setSelected([]);
    setRestore([]);
  }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const imported = await importLegacy();
        const local = await listProjects();
        let remote: Project[] = [];
        try {
          remote = (await api<unknown[]>("/api/projects")).map(parseProject);
          if (active) setReady(true);
        } catch (error) {
          if (active) setMessage(errorText(error));
        }
        const merged = new Map<string, Project>();
        for (const p of [
          ...local,
          ...remote,
          ...(imported ? [imported] : []),
        ]) {
          const previous = merged.get(p.id);
          if (!previous || p.revision > previous.revision) merged.set(p.id, p);
          else if (
            p.revision === previous.revision &&
            JSON.stringify(p) !== JSON.stringify(previous)
          ) {
            const copy = { ...p, id: uid(), name: `${p.name} · 충돌 복사본` };
            merged.set(copy.id, copy);
            await persistProject(copy);
          }
        }
        const projects = [...merged.values()].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        );
        if (active) {
          setLibrary(projects);
          if (projects[0]) openProject(projects[0]);
          setLoaded(true);
        }
      } catch (error) {
        if (active) {
          setMessage(
            `복구가 필요합니다: ${errorText(error)}. 원본은 보존되어 있습니다. 프로젝트 파일을 가져오거나 새 프로젝트를 시작하세요.`,
          );
          setSaveState("변경 사항 저장 대기");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [openProject]);
  useEffect(() => {
    if (!loaded) return;
    setSaveState("변경 사항 저장 중");
    const seq = ++saveSequence.current;
    const timer = setTimeout(() => {
      autosave.current = autosave.current.then(async () => {
        try {
          await persistProject(project);
          setLibrary((current) => [
            project,
            ...current.filter((p) => p.id !== project.id),
          ]);
          if (seq === saveSequence.current) setSaveState("자동 저장 완료");
          if (ready) {
            try {
              await api("/api/projects", "PUT", project);
            } catch (error) {
              if (seq === saveSequence.current)
                setSaveState(
                  `로컬 저장 완료 · 서버 백업 실패: ${errorText(error)}`,
                );
            }
          }
        } catch (error) {
          if (seq === saveSequence.current) {
            setSaveState("저장 실패");
            setMessage(errorText(error));
          }
        }
      });
    }, 650);
    return () => clearTimeout(timer);
  }, [project, loaded, ready]);
  useEffect(() => {
    if (!loaded) return;
    const channel = new BroadcastChannel("automade-projects");
    channel.onmessage = (event) => {
      const data = record(event.data);
      if (
        data.id === project.id &&
        typeof data.revision === "number" &&
        data.revision > project.revision
      )
        setMessage(
          "다른 탭에서 더 최신 내용을 저장했습니다. 현재 내용을 내보낸 뒤 프로젝트를 다시 불러오세요.",
        );
    };
    channel.postMessage({ id: project.id, revision: project.revision });
    return () => channel.close();
  }, [project.id, project.revision, loaded]);
  const removeSelection = useCallback(() => {
    if (!selected.length) return;
    setHistory((current) =>
      historyChange(
        current,
        deleteBlocks(
          current.present,
          selected.filter(
            (id) => !current.present.blocks.find((b) => b.id === id)?.locked,
          ),
        ),
      ),
    );
    setSelected([]);
  }, [selected]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing =
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) ||
        target?.isContentEditable;
      if (editing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setHistory((current) =>
          event.shiftKey ? redo(current) : undo(current),
        );
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "y"
      ) {
        event.preventDefault();
        setHistory(redo);
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "d"
      ) {
        event.preventDefault();
        setHistory((current) =>
          historyChange(current, duplicateBlocks(current.present, selected)),
        );
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        removeSelection();
      } else if (event.key === "Escape") {
        setSelected([]);
        setTestMode(false);
      } else if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
          event.key,
        ) &&
        selected.length &&
        !testMode
      ) {
        event.preventDefault();
        const amount = event.shiftKey
          ? project.canvas.gridSize * 10
          : project.canvas.gridSize;
        apply((p) => {
          for (const b of p.blocks)
            if (
              selected.includes(b.id) &&
              !b.locked &&
              b.layout.mode === "absolute"
            ) {
              b.layout.x = Math.max(
                0,
                b.layout.x +
                  (event.key === "ArrowLeft"
                    ? -amount
                    : event.key === "ArrowRight"
                      ? amount
                      : 0),
              );
              b.layout.y = Math.max(
                0,
                b.layout.y +
                  (event.key === "ArrowUp"
                    ? -amount
                    : event.key === "ArrowDown"
                      ? amount
                      : 0),
              );
            }
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected, removeSelection, project.canvas.gridSize, apply, testMode]);
  const addBlock = (type: BlockType, point?: { x: number; y: number }) => {
    const b = createBlock(type, project, activePage.id);
    if (point) {
      b.layout.mode = "absolute";
      b.layout.x = Math.max(0, point.x);
      b.layout.y = Math.max(0, point.y);
    }
    apply((p) => {
      p.blocks.push(b);
    });
    setSelected([b.id]);
  };
  const importFile = async (file: File) => {
    try {
      if (file.size > 32_000_000)
        throw new Error("프로젝트 파일이 32MB를 초과합니다.");
      const raw = await file.text();
      await preserveEvidence(raw, file.name);
      const imported = parseProject(JSON.parse(raw) as unknown);
      if (library.some((p) => p.id === imported.id)) {
        imported.id = uid();
        imported.name += " · 가져온 복사본";
      }
      await persistProject(imported);
      openProject(imported);
      setLibrary((current) => [imported, ...current]);
      setLoaded(true);
      setMessage("프로젝트를 가져왔습니다. 원본 파일 데이터도 보존했습니다.");
    } catch (error) {
      setMessage(errorText(error));
    }
  };
  const addAsset = async (file: File) => {
    try {
      if (
        file.size > 5_000_000 ||
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          file.type,
        )
      )
        throw new Error(
          "PNG, JPEG, GIF, WEBP 이미지만 5MB까지 사용할 수 있습니다.",
        );
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
        reader.readAsDataURL(file);
      });
      const asset: Asset = {
        id: uid(),
        name: file.name,
        mime: file.type as Asset["mime"],
        data,
        alt: "",
      };
      apply((p) => {
        p.assets.push(asset);
      });
      setMessage("이미지를 추가했습니다. 대체 텍스트를 입력하세요.");
    } catch (error) {
      setMessage(errorText(error));
    }
  };
  const showBackups = async () => {
    try {
      const local = await recoverProjects(project.id);
      const remote = ready
        ? (
            await api<unknown[]>("/api/projects/" + project.id + "/backups")
          ).map(parseProject)
        : [];
      const backups = [
        ...new Map([...local, ...remote].map((p) => [p.revision, p])).values(),
      ].sort((a, b) => b.revision - a.revision);
      setRestore(backups);
      if (!backups.length) setMessage("복구할 이전 저장본이 없습니다.");
    } catch (error) {
      setMessage(errorText(error));
    }
  };
  const exportOriginal = () =>
    downloadFile(
      `${project.name}.interface.json`,
      JSON.stringify(project, null, 2),
    );
  return {
    project,
    history,
    setHistory,
    library,
    setLibrary,
    loaded,
    setLoaded,
    ready,
    saveState,
    message,
    setMessage,
    selected,
    setSelected,
    pageId,
    setPageId,
    panel,
    setPanel,
    testMode,
    setTestMode,
    restore,
    activePage,
    selectedBlock,
    issues,
    apply,
    openProject,
    removeSelection,
    addBlock,
    importFile,
    addAsset,
    showBackups,
    exportOriginal,
  };
}
export type StudioState = ReturnType<typeof useStudio>;
