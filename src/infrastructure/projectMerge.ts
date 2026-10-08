import type { Project } from "../domain/types";
import { inspectProject, parseProject } from "../domain/validation";
export interface MergeConflict {
  path: string;
  base: unknown;
  local: unknown;
  remote: unknown;
  kind?: "field" | "delete" | "order" | "schema" | "approval";
}
export interface ProjectMerge {
  project: Project | null;
  conflicts: MergeConflict[];
  error: string | null;
}
export type MergeChoices = Record<string, "local" | "remote">;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const copy = (value: unknown) =>
  value === undefined ? undefined : structuredClone(value);
function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function safe(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(safe);
    return;
  }
  if (plain(value))
    for (const [key, item] of Object.entries(value)) {
      if (forbidden.has(key)) throw new Error("안전하지 않은 변경 경로입니다.");
      safe(item);
    }
}
function keyed(
  value: unknown,
): value is Array<Record<string, unknown> & { id: string }> {
  return (
    Array.isArray(value) &&
    value.every((item) => plain(item) && typeof item.id === "string") &&
    new Set(value.map((item) => item.id)).size === value.length
  );
}
export function mergeProjects(
  base: Project,
  local: Project,
  remote: Project,
  choices: MergeChoices = {},
): ProjectMerge {
  const conflicts: MergeConflict[] = [];
  function conflict(b: unknown, l: unknown, r: unknown, path: string): unknown {
    const kind= l===undefined||r===undefined ? "delete" : path.endsWith("/$order") ? "order" : /\/schema(?:\/|$)/.test(path) ? "schema" : /\/workflow(?:\/|$)|approvedRevision/.test(path) ? "approval" : "field";
    conflicts.push({ path, base: copy(b), local: copy(l), remote: copy(r),kind });
    return copy(choices[path] === "remote" ? r : l);
  }
  function merge(b: unknown, l: unknown, r: unknown, path: string): unknown {
    if (equal(l, r)) return copy(l);
    if (equal(l, b)) return copy(r);
    if (equal(r, b)) return copy(l);
    if (plain(b) && plain(l) && plain(r)) {
      const result: Record<string, unknown> = {};
      for (const key of new Set([
        ...Object.keys(b),
        ...Object.keys(l),
        ...Object.keys(r),
      ])) {
        if (path === "" && (key === "revision" || key === "updatedAt"))
          continue;
        const value = merge(
          b[key],
          l[key],
          r[key],
          `${path}/${encodeURIComponent(key)}`,
        );
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    if (keyed(b) && keyed(l) && keyed(r)) {
      const bm = new Map(b.map((item) => [item.id, item])),
        lm = new Map(l.map((item) => [item.id, item])),
        rm = new Map(r.map((item) => [item.id, item]));
      const bi = b.map((x) => x.id),
        li = l.map((x) => x.id),
        ri = r.map((x) => x.id);
      const order = equal(li, bi)
        ? ri
        : equal(ri, bi) || equal(li, ri)
          ? li
          : (conflict(bi, li, ri, `${path}/$order`) as string[]);
      const ids = [...new Set([...order, ...li, ...ri])];
      return ids
        .map((id) =>
          merge(
            bm.get(id),
            lm.get(id),
            rm.get(id),
            `${path}/@${encodeURIComponent(id)}`,
          ),
        )
        .filter((item) => item !== undefined);
    }
    return conflict(b, l, r, path);
  }
  try {
    if (base.id !== local.id || base.id !== remote.id)
      throw new Error("동일한 프로젝트만 병합할 수 있습니다.");
    safe(base);
    safe(local);
    safe(remote);
    const result = merge(base, local, remote, "");
    if (!plain(result)) throw new Error("병합 문서를 확인하지 못했습니다.");
    result.revision =
      Math.max(base.revision, local.revision, remote.revision) + 1;
    result.updatedAt = new Date().toISOString();
    const project=parseProject(result),codes=new Set(["ACTION_TARGET","BAD_PARENT","CYCLE","BAD_PAGE","CHART_TARGET","COLLECTION_TARGET","CMS_PRIVATE_REFERENCE"]),key=(issue:{code:string;blockId?:string;message:string})=>`${issue.code}:${issue.blockId||""}:${issue.message}`;
    const existing=new Set([...inspectProject(base),...inspectProject(local),...inspectProject(remote)].map(key));
    const broken=inspectProject(project).filter(issue=>codes.has(issue.code)&&!existing.has(key(issue)));
    return { project, conflicts, error: broken.length ? `병합 후 새 연결 오류가 있습니다. 삭제·참조 변경을 편집본에서 확인한 뒤 다시 비교하세요: ${broken.map(issue=>issue.message).join(" · ")}` : null };
  } catch (e) {
    return {
      project: null,
      conflicts,
      error: e instanceof Error ? e.message : "변경 병합을 확인하세요.",
    };
  }
}
