import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
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
import type { BlockType, ContentRecord, Issue, Project } from "../domain/types";
import { prepareAsset } from "../infrastructure/assets";
import { trackStudioEvent } from "../infrastructure/telemetry";
import {
  downloadFile,
  importLegacy,
  listProjects,
  listSyncBases,
  libraryIdentity,
  rememberSyncBase,
  persistProject,
  preserveEvidence,
  recoverProjects,
} from "../infrastructure/library";
import { api, ApiError, getProjectContext } from "../infrastructure/api";
import {
  queueCommand,
  commandState,
  listCommands,
} from "../infrastructure/projectJournal";
import type { SyncConflict } from "./SyncReview";
import { preflightProject } from "../domain/packages";
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "작업을 처리하지 못했습니다.";
export function useStudio() {
  const identity = useRef(libraryIdentity());
  const [history, setHistory] = useState<History>(() => ({
    past: [],
    present: createProject(),
    future: [],
  }));
  const project = history.present;
  const [editable, setEditable] = useState(false),
    editableRef = useRef(true);
  editableRef.current = editable;
  const [library, setLibrary] = useState<Project[]>([]),
    [loaded, setLoaded] = useState(false),
    [ready, setReady] = useState(false),
    [saveState, setSaveState] = useState("불러오는 중"),
    [message, setMessage] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [pageId, setPageId] = useState(project.pages[0]!.id),
    [panel, setPanel] = useState("blocks"),
    [testMode, setTestMode] = useState(false),
    [restore, setRestore] = useState<Project[]>([]),
    [inspectorOpen, setInspectorOpen] = useState(false),
    [assetProgress, setAssetProgress] = useState(""),
    [lastSaved, setLastSaved] = useState("");
  const [online, setOnline] = useState(navigator.onLine),
    [syncConflict, setSyncConflict] = useState<SyncConflict | null>(null);
  const [unsupportedImport, setUnsupportedImport] = useState<{
    raw: string;
    name: string;
    issues: string[];
  } | null>(null);
  const remoteBases = useRef(new Map<string, Project>()),
    pendingConflicts = useRef(new Map<string, SyncConflict>());
  const remoteSyncQueue = useRef<Promise<unknown>>(Promise.resolve());
  const editingGroup = useRef({ active: false, changed: false });
  const beginEditing = () => {
    editingGroup.current = { active: true, changed: false };
  };
  const endEditing = () => {
    editingGroup.current = { active: false, changed: false };
  };
  const saveSequence = useRef(0),
    autosave = useRef<Promise<void>>(Promise.resolve());
  const savedProject = useRef({ id: "", revision: -1 });
  const latest = useRef({ project, loaded, ready });
  latest.current = { project, loaded, ready };
  const activePage =
    project.pages.find((p) => p.id === pageId) ?? project.pages[0]!;
  const selectedBlock =
    project.blocks.find((b) => b.id === selected[0]) ?? null;
  const checkedProject = useDeferredValue(project);
  const issues = useMemo<Issue[]>(() => {
    try {
      return inspectProject(parseProject(checkedProject));
    } catch (error) {
      return [{ severity: "error", code: "SCHEMA", message: errorText(error) }];
    }
  }, [checkedProject]);
  const previousErrors = useRef({ projectId: project.id, count: 0 });
  useEffect(() => {
    const count = issues.filter((x) => x.severity === "error").length;
    if (
      previousErrors.current.projectId === project.id &&
      previousErrors.current.count > 0 &&
      count === 0
    )
      void trackStudioEvent(project.id, "quality.resolve");
    previousErrors.current = { projectId: project.id, count };
  }, [issues, project.id]);
  const apply = useCallback(
    (change: (p: Project) => void, expectedProjectId?: string) =>
      setHistory((current) => {
        if (expectedProjectId && current.present.id !== expectedProjectId) {
          setMessage(
            "작업 중 사이트가 변경되어 적용하지 않았습니다. 현재 사이트에서 다시 검토하세요.",
          );
          return current;
        }
        if (!editableRef.current) {
          setMessage("이 프로젝트는 읽기 전용입니다. 제작 권한을 확인하세요.");
          return current;
        }
        const next = commit(current.present, change);
        for (const block of next.blocks) {
          const previous = current.present.blocks.find(
            (item) => item.id === block.id,
          );
          if (!block.componentLink || !previous?.componentLink) continue;
          const overrides = new Set(block.componentLink.overrides);
          for (const group of ["props", "design", "layout"] as const)
            for (const key of Object.keys(block[group])) {
              const before = (
                  previous[group] as unknown as Record<string, unknown>
                )[key],
                after = (block[group] as unknown as Record<string, unknown>)[
                  key
                ];
              if (JSON.stringify(before) !== JSON.stringify(after))
                overrides.add(`${group}.${key}`);
            }
          block.componentLink.overrides = [...overrides];
        }
        if (
          next.extensions?.checklist &&
          (JSON.stringify(next.blocks) !==
            JSON.stringify(current.present.blocks) ||
            JSON.stringify(next.theme) !==
              JSON.stringify(current.present.theme) ||
            JSON.stringify(next.pages) !==
              JSON.stringify(current.present.pages))
        )
          next.extensions.checklist.forEach((item) => {
            item.checked = false;
          });
        const group = editingGroup.current;
        if (group.active && group.changed)
          return { ...current, present: next, future: [] };
        if (group.active) group.changed = true;
        return historyChange(current, next);
      }),
    [],
  );
  const syncProject = useCallback(
    async (
      snapshot: Project,
      onCanonical?: (canonical: Project) => void,
    ): Promise<boolean> => {
      const captured = getProjectContext(),
        environmentId =
          captured?.projectId === snapshot.id
            ? captured.environmentId || ""
            : "";
      const task = remoteSyncQueue.current.then(async () => {
        if (identity.current !== libraryIdentity()) return false;
        const base = remoteBases.current.get(snapshot.id);
        if (base && snapshot.revision < base.revision) return false;
        if (base && JSON.stringify(base) === JSON.stringify(snapshot)) {
          onCanonical?.(structuredClone(base));
          return true;
        }
        const command = base
          ? await queueCommand(base, snapshot, environmentId)
          : null;
        if (!navigator.onLine) {
          setSaveState("오프라인 · 이 기기 변경 보관");
          return false;
        }
        if (pendingConflicts.current.has(snapshot.id)) {
          setSaveState("서버 변경과 비교 필요");
          return false;
        }
        try {
          const result = record(
            command
              ? await api<unknown>(
                  `/api/projects/${snapshot.id}/commands?environmentId=${encodeURIComponent(command.environmentId || environmentId)}`,
                  "POST",
                  {
                    commandId: command.commandId,
                    baseRevision: command.baseRevision,
                    proposedRevision:
                      command.snapshot?.revision ?? snapshot.revision,
                    changes: command.changes,
                  },
                )
              : await api<unknown>("/api/projects", "PUT", {
                  project: snapshot,
                  baseRevision: base?.revision ?? -1,
                }),
          );
          if (identity.current !== libraryIdentity()) return false;
          const canonical = result.project
            ? parseProject(result.project)
            : snapshot;
          if (canonical.id !== snapshot.id)
            throw new Error("저장 응답의 프로젝트 범위를 확인하세요.");
          if (command) {
            if (result.ack !== true || result.commandId !== command.commandId)
              throw new Error(
                "변경 명령의 서버 확인을 검증하지 못했습니다. 이 기기 변경을 보존합니다.",
              );
            await commandState(command, "acknowledged", canonical.revision);
            for (const older of await listCommands(snapshot.id))
              if (
                older.commandId !== command.commandId &&
                ["pending", "blocked"].includes(older.status) &&
                older.snapshot &&
                older.snapshot.revision <= snapshot.revision
              )
                await commandState(
                  older,
                  "superseded",
                  canonical.revision,
                  `명령 ${command.commandId}의 확인된 최신 변경에 포함`,
                );
          }
          remoteBases.current.set(snapshot.id, structuredClone(canonical));
          await rememberSyncBase(canonical);
          if (
            JSON.stringify(canonical) !== JSON.stringify(snapshot) &&
            latest.current.project.id === snapshot.id &&
            latest.current.project.revision === snapshot.revision
          ) {
            await persistProject(canonical, { canonical: true });
            setHistory((h) =>
              h.present.id === snapshot.id &&
              h.present.revision === snapshot.revision
                ? { ...h, present: canonical }
                : h,
            );
          }
          window.dispatchEvent(
            new CustomEvent("automade:project-synced", { detail: snapshot.id }),
          );
          if (command)
            window.dispatchEvent(
              new CustomEvent("automade:outcome", {
                detail: {
                  projectId: snapshot.id,
                  environmentId,
                  eventId: `save:${command.commandId}`,
                  metric: "save-success",
                  value: 1,
                  failed: false,
                },
              }),
            );
          onCanonical?.(structuredClone(canonical));
          return true;
        } catch (error) {
          if (command)
            window.dispatchEvent(
              new CustomEvent("automade:outcome", {
                detail: {
                  projectId: snapshot.id,
                  environmentId,
                  eventId: `save-failure:${command.commandId}`,
                  metric: "save-success",
                  value: 0,
                  failed: true,
                },
              }),
            );
          if (
            command &&
            error instanceof ApiError &&
            [401, 403, 409].includes(error.status)
          )
            await commandState(command, "blocked", undefined, errorText(error));
          if (error instanceof ApiError && [401, 403].includes(error.status)) {
            setEditable(false);
            setSaveState("권한 확인 필요 · 이 기기 변경 보존");
          }
          if (error instanceof ApiError && error.status === 409) {
            const remote = parseProject(
              await api<unknown>(`/api/projects/${snapshot.id}`),
            );
            const conflict = {
              base: base ?? remote,
              local: structuredClone(snapshot),
              remote,
            };
            pendingConflicts.current.set(snapshot.id, conflict);
            setSyncConflict(conflict);
            setSaveState("동기화 충돌 · 변경 비교 필요");
            return false;
          }
          throw error;
        }
      });
      remoteSyncQueue.current = task.then(
        (value) => value,
        (error) => {
          setMessage(errorText(error));
          return false;
        },
      );
      return task;
    },
    [],
  );
  const openProject = useCallback(
    (p: Project) => {
      editingGroup.current = { active: false, changed: false };
      const previous = latest.current;
      if (
        previous.loaded &&
        JSON.stringify(previous.project) !== JSON.stringify(p)
      ) {
        autosave.current = autosave.current.then(async () => {
          if (identity.current !== libraryIdentity()) return;
          try {
            await persistProject(previous.project);
            if (previous.ready) await syncProject(previous.project);
          } catch (error) {
            setMessage("이전 프로젝트 저장을 확인하세요: " + errorText(error));
          }
        });
      }
      setHistory({ past: [], present: p, future: [] });
      setPageId(p.pages.find((x) => x.home)!.id);
      setSelected([]);
      setRestore([]);
    },
    [syncProject],
  );
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const imported = await importLegacy();
        const local = await listProjects();
        for (const base of await listSyncBases())
          remoteBases.current.set(base.id, base);
        let remote: Project[] = [];
        try {
          const pending = (await listCommands()).filter(
            (command) =>
              ["pending", "blocked"].includes(command.status) &&
              command.snapshot,
          );
          const byProject = new Map<string, typeof pending>();
          for (const command of pending)
            byProject.set(command.projectId, [
              ...(byProject.get(command.projectId) || []),
              command,
            ]);
          for (const [projectId, commands] of byProject)
            for (let offset = 0; offset < commands.length; offset += 100) {
              try {
                if (!active || identity.current !== libraryIdentity()) return;
                const batch = commands.slice(offset, offset + 100),
                  acknowledgements = await api<
                    { commandId: string; revision: number; ack: boolean }[]
                  >(
                    `/api/projects/${projectId}/commands?ids=${encodeURIComponent(batch.map((command) => command.commandId).join(","))}`,
                  );
                for (const acknowledgement of acknowledgements) {
                  const command = batch.find(
                    (command) =>
                      command.commandId === acknowledgement.commandId,
                  );
                  if (!command?.snapshot || acknowledgement.ack !== true)
                    continue;
                  if (!active || identity.current !== libraryIdentity()) return;
                  const replay = record(
                    await api<unknown>(
                      `/api/projects/${projectId}/commands?environmentId=${encodeURIComponent(command.environmentId || "")}`,
                      "POST",
                      {
                        commandId: command.commandId,
                        baseRevision: command.baseRevision,
                        proposedRevision: command.snapshot.revision,
                        changes: command.changes,
                      },
                    ),
                  );
                  const canonical = parseProject(replay.project);
                  if (
                    replay.ack !== true ||
                    replay.commandId !== command.commandId ||
                    canonical.id !== projectId ||
                    canonical.revision !== acknowledgement.revision
                  )
                    throw new Error(
                      "재전송한 변경 명령의 서버 확인이 일치하지 않습니다. 이 기기 원본을 보존했습니다.",
                    );
                  if (!active || identity.current !== libraryIdentity()) return;
                  remoteBases.current.set(
                    projectId,
                    structuredClone(canonical),
                  );
                  await rememberSyncBase(canonical);
                  const index = local.findIndex(
                    (project) =>
                      project.id === projectId &&
                      JSON.stringify(project) ===
                        JSON.stringify(command.snapshot),
                  );
                  if (index >= 0) {
                    local[index] = canonical;
                    await persistProject(canonical, { canonical: true });
                  }
                  await commandState(
                    command,
                    "acknowledged",
                    canonical.revision,
                  );
                }
              } catch (error) {
                if (active)
                  setMessage(
                    "이 기기 변경을 보존했습니다. 서버 확인 재조회: " +
                      errorText(error),
                  );
              }
            }
          remote = (await api<unknown[]>("/api/projects")).map(parseProject);
          for (const value of remote) {
            const base = remoteBases.current.get(value.id),
              own = local.find((x) => x.id === value.id);
            if (
              own &&
              JSON.stringify(own) !== JSON.stringify(value) &&
              (!base ||
                (JSON.stringify(own) !== JSON.stringify(base) &&
                  JSON.stringify(value) !== JSON.stringify(base)))
            ) {
              const conflict = {
                base: base ?? value,
                local: own,
                remote: value,
              };
              pendingConflicts.current.set(value.id, conflict);
              setSyncConflict(conflict);
            } else {
              remoteBases.current.set(value.id, structuredClone(value));
              await rememberSyncBase(value);
            }
          }
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
            !pendingConflicts.current.has(p.id) &&
            p.revision === previous.revision &&
            JSON.stringify(p) !== JSON.stringify(previous)
          ) {
            const copy = { ...p, id: uid(), name: `${p.name} · 충돌 복사본` };
            merged.set(copy.id, copy);
            await persistProject(copy);
          }
        }
        for (const [id, conflict] of pendingConflicts.current)
          merged.set(id, conflict.local);
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
        if (identity.current !== libraryIdentity()) return;
        try {
          await persistProject(project);
          savedProject.current = { id: project.id, revision: project.revision };
          setLibrary((current) => [
            project,
            ...current.filter((p) => p.id !== project.id),
          ]);
          if (seq === saveSequence.current) {
            setSaveState("자동 저장 완료");
            setLastSaved(new Date().toISOString());
          }
          if (ready) {
            try {
              const synced = await syncProject(project);
              if (synced && seq === saveSequence.current)
                setSaveState("자동 저장 완료");
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
  }, [project, loaded, ready, syncProject]);
  useEffect(() => {
    const disconnected = () => {
      setOnline(false);
      setSaveState("오프라인 · 이 기기 변경 보관");
    };
    const connected = () => {
      setOnline(true);
      if (latest.current.loaded)
        void syncProject(latest.current.project)
          .then((synced) => {
            if (synced) setSaveState("온라인 동기화 완료");
          })
          .catch((error) => setMessage(errorText(error)));
    };
    window.addEventListener("offline", disconnected);
    window.addEventListener("online", connected);
    return () => {
      window.removeEventListener("offline", disconnected);
      window.removeEventListener("online", connected);
    };
  }, [syncProject]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const current = latest.current;
      if (
        current.loaded &&
        (savedProject.current.id !== current.project.id ||
          savedProject.current.revision !== current.project.revision)
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
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
    if (!editableRef.current) {
      setMessage("현재 문서는 읽기 전용입니다.");
      return;
    }
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
      if (
        target.closest('[role="tree"]') &&
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(event.key)
      )
        return;
      if (!editableRef.current && event.key !== "Escape") return;
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
    b.design.themeMode = "theme";
    if (point) {
      b.layout.mode = "absolute";
      b.layout.x = Math.max(0, point.x);
      b.layout.y = Math.max(0, point.y);
    }
    apply((p) => {
      p.blocks.push(b);
      p.extensions ??= {};
      p.extensions.recentBlocks = [
        type,
        ...(p.extensions.recentBlocks || []).filter((x) => x !== type),
      ].slice(0, 16);
    });
    setSelected([b.id]);
    setInspectorOpen(true);
  };
  const importFile = async (file: File) => {
    try {
      if (file.size > 32_000_000)
        throw new Error("프로젝트 파일이 32MB를 초과합니다.");
      const raw = await file.text();
      await preserveEvidence(raw, file.name);
      const value = JSON.parse(raw) as unknown;
      const compatibility = preflightProject(value);
      if (!compatibility.supported) {
        setUnsupportedImport({
          raw,
          name: file.name,
          issues: compatibility.issues.map((issue) => issue.message),
        });
        return;
      }
      const imported = parseProject(value);
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
  const addAsset = async (file: File, replaceId?: string, compress = true) => {
    try {
      const asset = await prepareAsset(file, compress, setAssetProgress);
      apply((p) => {
        const old = replaceId
          ? p.assets.find((x) => x.id === replaceId)
          : undefined;
        if (old)
          Object.assign(old, asset, {
            id: old.id,
            alt: old.alt,
            source: old.source,
            license: old.license,
          });
        else p.assets.push(asset);
      });
      setMessage(
        `${replaceId ? "이미지를 교체하고 연결을 유지했습니다." : "이미지를 추가했습니다."} ${(file.size / 1024).toFixed(1)} → ${((asset.bytes || file.size) / 1024).toFixed(1)}KB. 대체 텍스트를 확인하세요.`,
      );
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setAssetProgress("");
    }
  };
  const retrySave = async () => {
    try {
      setSaveState("변경 사항 저장 중");
      await persistProject(project);
      const synced = await syncProject(project);
      if (!synced) return;
      setReady(true);
      setLastSaved(new Date().toISOString());
      setSaveState("자동 저장 완료");
      setMessage("로컬 저장과 서버 백업을 확인했습니다.");
    } catch (error) {
      setSaveState("저장 상태 확인 필요");
      setMessage(errorText(error));
    }
  };
  const focusIssue = (issue: Issue) => {
    if (issue.pageId && issue.pageId !== "*") setPageId(issue.pageId);
    setSelected(issue.blockId ? [issue.blockId] : []);
    setInspectorOpen(true);
    if (issue.code === "PAGE_TITLE" || issue.code === "EMPTY_PAGE")
      setPanel("pages");
    const labels: Record<string, string> = {
      DESCRIPTION: "검색·공유 설명",
      NAME: "사이트 이름",
      IMAGE_ALT: "대체 텍스트",
      IMAGE_EMPTY: "이미지",
      FORM_TARGET: "저장 대상",
      FORM_FIELDS: "필드 추가",
      HEADING: "제목",
      UNCONNECTED_ACTION: "동작",
      CONTRAST: "글자",
      ACTION_TARGET: "대상",
      BAD_PARENT: "부모 컨테이너",
    };
    setTimeout(() => {
      const area = document.querySelector(
        issue.code === "PAGE_TITLE" ? ".tool-panel" : ".properties",
      );
      if (!area) return;
      const target = [...area.querySelectorAll("label")].find(
        (label) =>
          [...label.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || "")
            .join("")
            .trim() === (labels[issue.code] || issue.field || "제목"),
      );
      for (
        let ancestor = target?.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      )
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      const input = target?.querySelector<HTMLElement>(
        "input,textarea,select,button",
      );
      input?.focus();
      input?.scrollIntoView({ block: "nearest" });
    }, 100);
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
  const exportOriginal = async () => {
    try {
      await autosave.current;
      await persistProject(project);
      savedProject.current = { id: project.id, revision: project.revision };
      setLastSaved(new Date().toISOString());
    } catch (error) {
      setMessage(
        `저장소 확인이 필요합니다. 원본 파일은 내보냈습니다: ${errorText(error)}`,
      );
    }
    downloadFile(
      `${project.name}.interface.json`,
      JSON.stringify(project, null, 2),
    );
  };
  return {
    project,
    history,
    setHistory: (action: React.SetStateAction<History>) => {
      if (editableRef.current) setHistory(action);
      else setMessage("현재 문서는 읽기 전용입니다.");
    },
    editable,
    setEditable,
    library,
    setLibrary,
    loaded,
    setLoaded,
    ready,
    inspectorOpen,
    setInspectorOpen,
    assetProgress,
    lastSaved,
    online,
    syncConflict,
    hasSyncConflict: pendingConflicts.current.has(project.id),
    syncProject,
    acceptServerRecord: async (
      collectionId: string,
      value: ContentRecord,
      expectedRevision: number,
    ) => {
      const next = structuredClone(value),
        owner = libraryIdentity(),
        base = remoteBases.current.get(latest.current.project.id);
      let conflict: SyncConflict | null = null,
        accepted = false;
      const replace = (document: Project) => {
        const copy = structuredClone(document),
          collection = copy.collections?.find(
            (item) => item.id === collectionId,
          );
        if (collection) {
          const index = collection.records.findIndex(
            (item) => item.id === next.id,
          );
          if (index >= 0) collection.records[index] = next;
          else collection.records.push(next);
        }
        return copy;
      };
      flushSync(() =>
        setHistory((current) => {
          if (
            owner !== identity.current ||
            current.present.id !== latest.current.project.id
          )
            return current;
          const before = current.present.collections
            ?.find((item) => item.id === collectionId)
            ?.records.find((item) => item.id === next.id);
          if (before && (before.contentRevision || 0) !== expectedRevision) {
            conflict = {
              base: base || current.present,
              local: current.present,
              remote: replace(base || current.present),
            };
            return current;
          }
          accepted = true;
          return { ...current, present: replace(current.present) };
        }),
      );
      if (conflict) {
        pendingConflicts.current.set(latest.current.project.id, conflict);
        setSyncConflict(conflict);
        setMessage(
          "동시에 수정된 콘텐츠를 보존했습니다. 서버 한 건의 결과와 편집본을 비교하세요.",
        );
        return false;
      }
      if (accepted && base) {
        const canonical = replace(base);
        remoteBases.current.set(canonical.id, canonical);
        await rememberSyncBase(canonical);
      }
      return accepted;
    },
    openServerProject: async (value: Project) => {
      const next = parseProject(value);
      if (identity.current !== libraryIdentity()) return;
      remoteBases.current.set(next.id, structuredClone(next));
      await rememberSyncBase(next);
      await persistProject(next, { canonical: true });
      openProject(next);
    },
    acceptServerProject: async (value: Project, expectedRevision: number) => {
      const next = parseProject(value);
      if (
        identity.current !== libraryIdentity() ||
        next.id !== latest.current.project.id
      )
        return;
      const base = remoteBases.current.get(next.id);
      let conflict: SyncConflict | null = null;
      let applied = false;
      // Commit against the actual queued state before any IndexedDB await.
      // Edits after this commit build on the accepted revision and stay intact.
      flushSync(() =>
        setHistory((current) => {
          if (
            identity.current !== libraryIdentity() ||
            current.present.id !== next.id
          )
            return current;
          if (current.present.revision !== expectedRevision) {
            conflict = {
              base: structuredClone(base || current.present),
              local: structuredClone(current.present),
              remote: next,
            };
            return current;
          }
          applied = true;
          return historyChange(current, next);
        }),
      );
      if (conflict) {
        pendingConflicts.current.set(next.id, conflict);
        setSyncConflict(conflict);
        setMessage(
          "서버 처리 중 기기 원본이 변경되었습니다. 새 변경을 보존하고 서버 결과와 비교합니다.",
        );
        return;
      }
      if (!applied) return;
      remoteBases.current.set(next.id, structuredClone(next));
      pendingConflicts.current.delete(next.id);
      setSyncConflict(null);
      // The accepted current document follows the ordinary autosave queue.
      // No delayed canonical write can replace a newer IndexedDB document.
      await rememberSyncBase(next);
    },
    unsupportedImport,
    closeUnsupportedImport: () => setUnsupportedImport(null),
    closeSyncReview: () => setSyncConflict(null),
    reviewSync: () => {
      const value = pendingConflicts.current.get(project.id);
      if (value) {
        const updated = { ...value, local: structuredClone(project) };
        pendingConflicts.current.set(project.id, updated);
        setSyncConflict(updated);
      }
    },
    applySync: (merged: Project) => {
      if (!editableRef.current) return;
      const conflict = pendingConflicts.current.get(merged.id);
      if (!conflict || merged.id !== project.id) return;
      if (project.revision !== conflict.local.revision) {
        const updated = { ...conflict, local: structuredClone(project) };
        pendingConflicts.current.set(project.id, updated);
        setSyncConflict(updated);
        setMessage(
          "검토 중 원본이 변경되었습니다. 최신 기기 변경을 다시 비교하세요.",
        );
        return;
      }
      remoteBases.current.set(merged.id, conflict.remote);
      pendingConflicts.current.delete(merged.id);
      setSyncConflict(null);
      setHistory((current) => historyChange(current, merged));
    },
    retrySave,
    focusIssue,
    beginEditing,
    endEditing,
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
    qualityPending: checkedProject !== project,
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
