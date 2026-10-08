import type { ExpansionBootstrap } from "../domain/expansion";
import type { StepUpInput } from "../domain/advancement";
import type { ProjectRequestContext, StepUpTarget } from "./api";
export function stepUpScope(
  target: StepUpTarget,
  origin: string,
  context: ProjectRequestContext | null,
  bootstrap: ExpansionBootstrap | null,
): Pick<StepUpInput, "projectId" | "environmentId"> {
  const url = new URL(target.path, origin),
    raw =
      target.payload &&
      typeof target.payload === "object" &&
      !Array.isArray(target.payload)
        ? (target.payload as Record<string, unknown>)
        : {};
  if (
    /^\/api\/expansion\/(?:organizations|workspaces|members|invites|secrets)(?:\/|$)/.test(
      url.pathname,
    )
  )
    return {};
  const environment = url.pathname.match(
    /^\/api\/expansion\/environments\/([^/]+)$/,
  );
  if (environment) {
    const item = bootstrap?.environments.find(
      (value) => value.id === environment[1],
    );
    if (!item)
      throw new Error("추가 인증할 환경의 현재 권한·범위를 다시 조회하세요.");
    return { projectId: item.projectId, environmentId: item.id };
  }
  if (
    url.pathname === "/api/expansion/environments" ||
    /^\/api\/expansion\/sites(?:\/|$)/.test(url.pathname)
  ) {
    const siteId =
        typeof raw.siteId === "string"
          ? raw.siteId
          : url.pathname.match(/^\/api\/expansion\/sites\/([^/]+)$/)?.[1],
      site = bootstrap?.sites.find((value) => value.id === siteId),
      projectId =
        site?.projectId ||
        (typeof raw.projectId === "string" ? raw.projectId : undefined),
      production = bootstrap?.environments.find(
        (value) => value.projectId === projectId && value.kind === "production",
      );
    if (!projectId || !production)
      throw new Error("추가 인증할 원본 사이트의 운영 환경을 먼저 확인하세요.");
    return { projectId, environmentId: production.id };
  }
  const projectId =
      url.searchParams.get("projectId") ||
      url.pathname.match(/^\/api\/projects\/([^/]+)/)?.[1] ||
      context?.projectId,
    environmentId =
      url.searchParams.get("environmentId") || context?.environmentId;
  return {
    ...(projectId ? { projectId } : {}),
    ...(environmentId ? { environmentId } : {}),
  };
}
