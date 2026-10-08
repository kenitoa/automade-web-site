import { useEffect, useRef, useState } from "react";
import type {
  ExpansionBootstrap,
  ExpansionCapability,
  ExpansionSite,
} from "../domain/expansion";
import {
  api,
  ApiError,
  setCreatorCsrf,
  setProjectContext,
} from "../infrastructure/api";
import { parseProject, record } from "../domain/validation";
import type { StudioState } from "./useStudio";
import { useCreatorSession } from "./CreatorGate";
function parseBootstrap(value: unknown): ExpansionBootstrap {
  const raw = record(value);
  for (const key of [
    "organizations",
    "workspaces",
    "sites",
    "environments",
    "capabilities",
  ])
    if (!Array.isArray(raw[key]))
      throw new Error("작업 공간 목록 계약을 확인하세요.");
  const session = record(raw.session);
  if (
    typeof session.csrf !== "string" ||
    typeof session.localOwner !== "boolean"
  )
    throw new Error("제작자 세션 계약을 확인하세요.");
  if (raw.currentScope !== null) {
    const scope = record(raw.currentScope);
    for (const key of ["organizationId", "workspaceId", "projectId"])
      if (typeof scope[key] !== "string")
        throw new Error("작업 범위 계약을 확인하세요.");
  }
  return raw as unknown as ExpansionBootstrap;
}
export function useExpansion(studio: StudioState) {
  const { session, logout } = useCreatorSession(),
    [bootstrap, setBootstrap] = useState<ExpansionBootstrap | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [environmentId, setEnvironmentId] = useState(""),
    [workspaceId, setWorkspaceId] = useState("");
  const requestSequence = useRef(0),
    currentProject = useRef(studio.project.id);
  currentProject.current = studio.project.id;
  async function refresh(environment = environmentId) {
    const seq = ++requestSequence.current,
      id = studio.project.id;
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({
        projectId: id,
        ...(environment ? { environmentId: environment } : {}),
      });
      let raw: unknown;
      try {
        raw = await api<unknown>(`/api/expansion/bootstrap?${query}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && !environment)
          raw = await api<unknown>("/api/expansion/bootstrap");
        else throw e;
      }
      if (seq !== requestSequence.current || id !== currentProject.current)
        return;
      const next = parseBootstrap(raw);
      setCreatorCsrf(next.session.csrf);
      setBootstrap(next);
      setEnvironmentId(next.currentScope?.environmentId || "");
      setWorkspaceId(
        next.currentScope?.workspaceId ||
          workspaceId ||
          next.workspaces.find((item) => !item.archived)?.id ||
          "",
      );
    } catch (e) {
      if (seq === requestSequence.current)
        setError(e instanceof Error ? e.message : "작업 공간을 확인하세요.");
    } finally {
      if (seq === requestSequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    setBootstrap(null);
    setEnvironmentId("");
    void refresh("");
    return () => {
      requestSequence.current++;
    };
  }, [studio.project.id]);
  const scope = bootstrap?.currentScope;
  useEffect(() => {
    const synced = (event: Event) => {
      if (!scope && (event as CustomEvent<string>).detail === studio.project.id)
        void refresh("");
    };
    window.addEventListener("automade:project-synced", synced);
    return () => window.removeEventListener("automade:project-synced", synced);
  }, [studio.project.id, scope?.projectId]);
  useEffect(() => {
    const selected = scope?.workspaceId || workspaceId;
    setProjectContext(
      selected
        ? {
            projectId: studio.project.id,
            workspaceId: selected,
            environmentId: scope?.environmentId,
          }
        : null,
    );
    return () => setProjectContext(null);
  }, [
    studio.project.id,
    scope?.workspaceId,
    scope?.environmentId,
    workspaceId,
  ]);
  useEffect(() => {
    studio.setEditable(
      Boolean(
        bootstrap &&
        (session.localOwner ||
          bootstrap.capabilities.includes("project.edit") ||
          (!scope && bootstrap.capabilities.includes("project.create")) ||
          (!scope &&
            bootstrap.organizations.some(
              (org) => org.role === "owner" || org.role === "admin",
            ))),
      ),
    );
  }, [bootstrap, session.localOwner]);
  function endpoint(path: string) {
    const [route, query = ""] = path.split("?"),
      params = new URLSearchParams(query);
    if (!params.has("projectId")) params.set("projectId", studio.project.id);
    for (const key of [
      "organizationId",
      "workspaceId",
      "siteId",
      "environmentId",
    ] as const) {
      const value = scope?.[key];
      if (value && !params.has(key)) params.set(key, value);
    }
    return `/api/expansion/${route}?${params}`;
  }
  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    return api<T>(endpoint(path), method, body);
  }
  async function selectSite(site: ExpansionSite) {
    setBusy(true);
    try {
      const project = parseProject(
        await api<unknown>(`/api/projects/${site.projectId}`),
      );
      await studio.openServerProject(project);
    } catch (e) {
      studio.setMessage(
        e instanceof Error ? e.message : "사이트 원본을 열지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function selectWorkspace(id: string) {
    setWorkspaceId(id);
    const site = bootstrap?.sites.find(
      (item) => item.workspaceId === id && !item.archived,
    );
    if (site) await selectSite(site);
    else {
      studio.setPanel("projects");
      studio.setMessage(
        "선택한 작업 공간에 사이트가 없습니다. 작업 공간·사이트 관리에서 새 사이트를 만드세요.",
      );
    }
  }
  async function selectEnvironment(id: string) {
    await refresh(id);
  }
  function can(capability: ExpansionCapability) {
    return Boolean(
      bootstrap &&
      (session.localOwner ||
        bootstrap.capabilities.includes(capability) ||
        (!scope &&
          [
            "project.create",
            "workspace.manage",
            "org.manage",
            "project.edit",
          ].includes(capability) &&
          bootstrap.organizations.some(
            (org) => org.role === "owner" || org.role === "admin",
          ))),
    );
  }
  return {
    bootstrap,
    scope,
    session,
    workspaceId,
    logout: () =>
      logout().catch((e) =>
        studio.setMessage(
          e instanceof Error ? e.message : "제작자 로그아웃을 확인하세요.",
        ),
      ),
    busy,
    error,
    environmentId,
    refresh,
    request,
    selectSite,
    selectWorkspace,
    selectEnvironment,
    can,
  };
}
export type ExpansionState = ReturnType<typeof useExpansion>;
