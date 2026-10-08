import { useEffect, useRef, useState } from "react";
import type { ExportResult, Project } from "../domain/types";
import type { SiteSummary } from "../domain/operations";
import { parseProject } from "../domain/validation";
import { uid } from "../domain/catalog";
import { persistProject } from "../infrastructure/library";
import {
  api,
  getProjectContext,
  type ProjectRequestContext,
} from "../infrastructure/api";
import { trackStudioEvent } from "../infrastructure/telemetry";
import { errorText, type StudioState } from "./useStudio";
import { useCreatorSession } from "./CreatorGate";

function scopedPath(
  path: string,
  owner: string,
  scope: ProjectRequestContext | null,
): string {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("projectId", owner);
  url.searchParams.set("environmentId", scope?.environmentId || "");
  if (scope?.workspaceId)
    url.searchParams.set("workspaceId", scope.workspaceId);
  return url.pathname + url.search;
}
export interface Operations {
  stats: Record<string, number>;
  jobs: Array<{
    id: string;
    project_id?: string;
    status: string;
    created_at: string;
    stage?: string;
  }>;
  running: Array<{
    id: string;
    url: string;
    projectId?: string;
    revision?: number;
    readOnly?: boolean;
  }>;
  generationProvider: string;
  sites?: SiteSummary[];
}
interface Job {
  id?: string;
  revision?: number;
  projectId?: string;
  stage: string;
  status: "building" | "ready" | "failed" | "cancelled";
  result?: ExportResult;
  error?: string;
}
export function useGeneration(
  studio: StudioState,
  selectedEnvironmentId?: string,
) {
  const { session } = useCreatorSession();
  const accountScope = session.localOwner
    ? "local"
    : session.account?.id || "anonymous";
  const cacheKey = (owner: string) =>
    `automade-last-job:${accountScope}:${owner}`;
  const [busy, setBusy] = useState(false),
    [job, setJob] = useState<Job | null>(null),
    [result, setResult] = useState<ExportResult | null>(null),
    [operations, setOperations] = useState<Operations | null>(null),
    [submissions, setSubmissions] = useState<unknown[]>([]),
    [resultRevision, setResultRevision] = useState<number | null>(null);
  const jobId = useRef<string | null>(null);
  const jobContext = useRef<ProjectRequestContext | null>(null);
  const resultContext = useRef<ProjectRequestContext | null>(null);
  const rememberJob = (
    owner: string,
    id: string,
    scope: ProjectRequestContext | null,
  ) => {
    localStorage.setItem(cacheKey(owner), id);
    if (scope)
      localStorage.setItem(`${cacheKey(owner)}:scope`, JSON.stringify(scope));
    else localStorage.removeItem(`${cacheKey(owner)}:scope`);
  };
  const resultProjectId = useRef<string | null>(null);
  const projectId = useRef(studio.project.id);
  projectId.current = studio.project.id;
  const refresh = async () => {
    try {
      setOperations(await api<Operations>("/api/operations"));
    } catch (error) {
      studio.setMessage(errorText(error));
    }
  };
  const monitor = async (
    id: string,
    snapshotRevision: number,
    owner: string,
    popup: Window | null = null,
    active: () => boolean = () => true,
    scope: ProjectRequestContext | null = jobContext.current,
  ) => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && active()) {
      const current = await api<Job>(
        scopedPath(`/api/exports/${id}`, owner, scope),
      );
      if (owner !== projectId.current || !active()) return;
      setJob(current);
      if (current.status === "ready" && current.result) {
        setResult(current.result);
        setResultRevision(current.revision ?? snapshotRevision);
        resultProjectId.current = owner;
        resultContext.current = scope;
        const eventKey = `automade-first-run:${owner}`;
        if (!localStorage.getItem(eventKey))
          void trackStudioEvent(
            owner,
            "site.first-run",
            current.result.durationMs,
          ).then((sent) => {
            if (sent) localStorage.setItem(eventKey, "true");
          });
        if (popup && !popup.closed) popup.location.href = current.result.url;
        studio.setMessage("웹사이트 생성과 로컬 실행이 완료되었습니다.");
        studio.setPanel("output");
        return;
      }
      if (current.status === "failed" || current.status === "cancelled")
        throw new Error(current.error || "사이트 생성이 중단되었습니다.");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (active())
      throw new Error(
        "생성이 계속 진행 중일 수 있습니다. 운영 패널에서 저장된 상태를 확인하세요.",
      );
  };
  useEffect(() => {
    if (!studio.loaded) return;
    let active = true;
    const owner = studio.project.id,
      id =
        localStorage.getItem(cacheKey(owner)) ||
        (session.localOwner
          ? localStorage.getItem(`automade-last-job:${owner}`)
          : null);
    setResult(null);
    setResultRevision(null);
    setJob(null);
    jobId.current = id;
    jobContext.current = null;
    const context = localStorage.getItem(`${cacheKey(owner)}:scope`);
    if (context) {
      try {
        const parsed: unknown = JSON.parse(context);
        if (
          parsed &&
          typeof parsed === "object" &&
          "projectId" in parsed &&
          parsed.projectId === owner &&
          "workspaceId" in parsed &&
          typeof parsed.workspaceId === "string"
        )
          jobContext.current = {
            projectId: owner,
            workspaceId: parsed.workspaceId,
            ...("environmentId" in parsed &&
            typeof parsed.environmentId === "string"
              ? { environmentId: parsed.environmentId }
              : {}),
          };
      } catch {
        localStorage.removeItem(`${cacheKey(owner)}:scope`);
      }
    }
    if (id)
      void (async () => {
        try {
          const current = await api<Job>(
            scopedPath(`/api/exports/${id}`, owner, jobContext.current),
          );
          if (!active) return;
          setJob(current);
          if (current.status === "building") setBusy(true);
          await monitor(id, current.revision ?? -1, owner, null, () => active);
        } catch (error) {
          if (active) studio.setMessage(errorText(error));
        } finally {
          if (active) setBusy(false);
        }
      })();
    return () => {
      active = false;
    };
  }, [studio.loaded, studio.project.id]);
  const oneClick = async () => {
    if (busy) return;
    if (studio.issues.some((i) => i.severity === "error")) {
      studio.setPanel("quality");
      studio.setMessage(
        "생성 전에 오류를 수정하세요. 오류를 누르면 해당 위치로 이동합니다.",
      );
      return;
    }
    const popup = window.open("about:blank", "_blank");
    if (popup) {
      popup.opener = null;
      popup.document.body.textContent =
        "사이트를 생성하고 있습니다. 완료되면 자동으로 열립니다.";
    }
    setBusy(true);
    setJob({ stage: "프로젝트 검사", status: "building" });
    studio.setMessage("");
    const context = getProjectContext();
    const scope = context?.projectId === studio.project.id ? context : null;
    jobContext.current = scope;
    try {
      const snapshot = parseProject(studio.project);
      await persistProject(snapshot);
      const synchronized: { project: Project | null } = { project: null };
      if (
        !(await studio.syncProject(snapshot, (canonical) => {
          synchronized.project = canonical;
        })) ||
        !synchronized.project
      )
        throw new Error(
          "온라인 동기화와 서버 변경 비교를 완료한 뒤 생성하세요.",
        );
      const canonical = parseProject(synchronized.project);
      if (canonical.id !== snapshot.id)
        throw new Error("생성할 서버 원본의 프로젝트 범위를 확인하세요.");
      const response = await api<{ id: string }>(
        scopedPath("/api/exports", canonical.id, scope),
        "POST",
        {
          project: canonical,
          idempotencyKey: uid(),
        },
      );
      jobId.current = response.id;
      rememberJob(canonical.id, response.id, scope);
      await monitor(
        response.id,
        canonical.revision,
        canonical.id,
        popup,
        () => true,
        scope,
      );
    } catch (error) {
      studio.setMessage(errorText(error));
      if (popup && !popup.closed)
        popup.document.body.textContent = `사이트를 열지 못했습니다. ${errorText(error)} 편집기의 품질 검사와 작업 상태를 확인하세요.`;
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const cancel = () => {
    if (jobId.current)
      void api(
        scopedPath(
          `/api/exports/${jobId.current}/cancel`,
          studio.project.id,
          jobContext.current,
        ),
        "POST",
        {},
      ).catch((error) => studio.setMessage(errorText(error)));
  };
  const retry = async (id = jobId.current) => {
    if (!id || busy) return;
    setBusy(true);
    const scope =
      (id === jobId.current ? jobContext.current : null) || getProjectContext();
    jobContext.current = scope;
    try {
      const response = await api<{ id: string }>(
        scopedPath(`/api/exports/${id}/retry`, studio.project.id, scope),
        "POST",
        {},
      );
      jobId.current = response.id;
      rememberJob(studio.project.id, response.id, scope);
      await monitor(
        response.id,
        -1,
        studio.project.id,
        null,
        () => true,
        scope,
      );
    } catch (error) {
      studio.setMessage(errorText(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const designRollback = async (id: string) => {
    if (busy) return;
    setBusy(true);
    const scope = getProjectContext();
    jobContext.current = scope;
    try {
      const response = await api<{ id: string }>(
        scopedPath(
          `/api/exports/${id}/design-rollback`,
          studio.project.id,
          scope,
        ),
        "POST",
        {},
      );
      jobId.current = response.id;
      rememberJob(studio.project.id, response.id, scope);
      await monitor(
        response.id,
        -1,
        studio.project.id,
        null,
        () => true,
        scope,
      );
    } catch (error) {
      studio.setMessage(errorText(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const stop = async (id: string) => {
    try {
      await api(
        scopedPath(
          `/api/exports/${id}/stop`,
          studio.project.id,
          getProjectContext(),
        ),
        "POST",
        {},
      );
      await refresh();
    } catch (error) {
      studio.setMessage(errorText(error));
    }
  };
  const restart = async (id: string) => {
    try {
      const response = await api<{ url: string }>(
        scopedPath(
          "/api/exports/" + id + "/restart",
          studio.project.id,
          getProjectContext(),
        ),
        "POST",
        {},
      );
      setResult((current) =>
        current?.id === id ? { ...current, url: response.url } : current,
      );
      studio.setMessage("사이트가 다시 실행되었습니다: " + response.url);
      await refresh();
    } catch (error) {
      studio.setMessage(errorText(error));
    }
  };
  const loadSubmissions = async (id: string) => {
    try {
      setSubmissions(await api<unknown[]>(`/api/exports/${id}/submissions`));
    } catch (error) {
      studio.setMessage(errorText(error));
    }
  };
  const stale = Boolean(
    result &&
    (resultProjectId.current !== studio.project.id ||
      resultRevision !== studio.project.revision ||
      Boolean(
        resultContext.current?.environmentId &&
        selectedEnvironmentId &&
        resultContext.current.environmentId !== selectedEnvironmentId,
      )),
  );
  return {
    busy,
    job,
    result,
    resultRevision,
    retry,
    designRollback,
    operations,
    submissions,
    refresh,
    oneClick,
    cancel,
    stop,
    loadSubmissions,
    restart,
    stale,
  };
}
export type GenerationState = ReturnType<typeof useGeneration>;
