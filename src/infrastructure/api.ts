import type { ApiEnvelope } from "../domain/types";
let csrf = "";
let creatorCsrf = "";
export interface ProjectRequestContext {
  projectId: string;
  workspaceId: string;
  environmentId?: string;
}
let projectContext: ProjectRequestContext | null = null;
export interface StepUpTarget {path:string;method:string;payload:unknown}
let stepUpHandler:((target:StepUpTarget)=>Promise<string>)|null=null;
export function setStepUpHandler(handler:typeof stepUpHandler):void {stepUpHandler=handler;}
export function setProjectContext(value: typeof projectContext): void {
  projectContext = value;
}
export function getProjectContext(): ProjectRequestContext | null {
  return projectContext ? { ...projectContext } : null;
}
export function setCreatorCsrf(value: string): void {
  creatorCsrf = value;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export async function connect(): Promise<void> {
  const response = await fetch("/api/session", {
    credentials: "same-origin",
    signal: AbortSignal.timeout(10000),
  });
  const envelope = (await response.json()) as ApiEnvelope<{ csrf: string }>;
  if (!response.ok || !envelope.data)
    throw new Error(
      "로컬 저장 서비스에 연결할 수 없습니다. start-site.cmd로 실행하세요.",
    );
  csrf = envelope.data.csrf;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
  additionalHeaders?: Record<string, string>,
): Promise<T> {
  const creatorAtStart = creatorCsrf;
  if (!csrf) await connect();
  if (creatorAtStart !== creatorCsrf)
    throw new ApiError(
      "제작자 세션이 바뀌었습니다. 현재 계정에서 다시 요청하세요.",
      "SESSION_CHANGED",
      401,
    );
  if (projectContext) {
    const url = new URL(path, window.location.origin),
      scope = projectContext,
      raw =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : null,
      document =
        raw?.project && typeof raw.project === "object"
          ? (raw.project as Record<string, unknown>)
          : raw;
    const id =
      typeof document?.id === "string"
        ? document.id
        : url.searchParams.get("projectId") ||
          url.pathname.match(/^\/api\/projects\/([^/]+)/)?.[1] ||
          scope.projectId;
    if (
      url.pathname === "/api/generate" ||
      (url.pathname === "/api/projects" && method !== "GET")
    )
      if (!url.searchParams.has("workspaceId"))
        url.searchParams.set("workspaceId", scope.workspaceId);
    if (url.pathname.startsWith("/api/platform/")) {
      if (!url.searchParams.has("projectId"))
        url.searchParams.set("projectId", scope.projectId);
    }
    if (
      scope.environmentId &&
      id === scope.projectId &&
      (/^\/api\/(?:platform|exports)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/projects\/[^/]+\//.test(url.pathname)) &&
      !url.searchParams.has("environmentId")
    )
      url.searchParams.set("environmentId", scope.environmentId);
    path = url.pathname + url.search;
  }
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      ...(creatorCsrf ? { "X-Creator-CSRF": creatorCsrf } : {}),
      "X-Request-ID": crypto.randomUUID(),
      ...additionalHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(120000),
  });
  const result = (await response.json()) as ApiEnvelope<T>;
  if (response.status === 401 && creatorCsrf && !["MFA_CODE","MFA_ENROLLMENT","REAUTHENTICATE"].includes(result.error?.code||""))
    window.dispatchEvent(new Event("automade:creator-expired"));
  if(result.error?.code==="STEP_UP_REQUIRED"&&stepUpHandler&&!additionalHeaders?.["X-Step-Up-Token"]){const token=await stepUpHandler({path,method,payload:body??{}});return api<T>(path,method,body,signal,{...additionalHeaders,"X-Step-Up-Token":token});}
  if (!response.ok || result.error || result.data === null)
    throw new ApiError(
      result.error?.message ?? "요청을 처리하지 못했습니다.",
      result.error?.code ?? "REQUEST_FAILED",
      response.status,
    );
  return result.data;
}
