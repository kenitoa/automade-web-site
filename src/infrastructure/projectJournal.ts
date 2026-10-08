import type { Project } from "../domain/types";
import { libraryIdentity, libraryTransaction } from "./library";
export interface EditorChange {
  path: string;
  before: unknown;
  after: unknown;
}
export interface EditorCommand {
  commandId: string;
  projectId: string;
  owner: string;
  environmentId?: string;
  baseRevision: number;
  changes: EditorChange[];
  status: "pending" | "acknowledged" | "blocked" | "superseded";
  createdAt: string;
  revision?: number;
  reason?: string;
  snapshot?: Project;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const keyed = (v: unknown): v is (Record<string, unknown> & { id: string })[] =>
  Array.isArray(v) &&
  v.every((item) => plain(item) && typeof item.id === "string");
export function projectChanges(base: Project, next: Project): EditorChange[] {
  if (base.id !== next.id)
    throw new Error("같은 프로젝트의 변경만 전달할 수 있습니다.");
  const changes: EditorChange[] = [];
  function walk(before: unknown, after: unknown, path: string) {
    if (equal(before, after)) return;
    if (
      plain(before) &&
      plain(after) &&
      equal(Object.keys(before).sort(), Object.keys(after).sort())
    ) {
      for (const key of Object.keys(before)) {
        if (
          !path &&
          ["id", "schemaVersion", "revision", "updatedAt"].includes(key)
        )
          continue;
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw new Error("안전하지 않은 변경 경로입니다.");
        walk(before[key], after[key], path + "/" + encodeURIComponent(key));
      }
    } else if (
      keyed(before) &&
      keyed(after) &&
      equal(
        before.map((x) => x.id),
        after.map((x) => x.id),
      )
    ) {
      before.forEach((item, index) =>
        walk(item, after[index], path + "/@" + encodeURIComponent(item.id)),
      );
    } else if (!path && plain(after)) {
      for (const key of Object.keys(after))
        if (
          !["id", "schemaVersion", "revision", "updatedAt"].includes(key) &&
          !equal(before && plain(before) ? before[key] : null, after[key])
        )
          changes.push({
            path: "/" + encodeURIComponent(key),
            before: plain(before) ? (before[key] ?? null) : null,
            after: after[key],
          });
    } else
      changes.push({
        path,
        before: structuredClone(before),
        after: structuredClone(after),
      });
  }
  walk(
    JSON.parse(JSON.stringify(base)) as unknown,
    JSON.parse(JSON.stringify(next)) as unknown,
    "",
  );
  if (changes.length <= 1000) return changes;
  return Object.keys(next)
    .filter(
      (key) =>
        !["id", "schemaVersion", "revision", "updatedAt"].includes(key) &&
        !equal(base[key as keyof Project], next[key as keyof Project]),
    )
    .map((key) => ({
      path: "/" + key,
      before: base[key as keyof Project] ?? null,
      after: next[key as keyof Project] ?? null,
    }));
}
export async function listCommands(
  projectId?: string,
): Promise<EditorCommand[]> {
  const values = await libraryTransaction<EditorCommand[]>(
    "commands",
    "readonly",
    (store) => store.getAll(),
  );
  return values
    .filter((command) => !projectId || command.projectId === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function queueCommand(
  base: Project,
  snapshot: Project,
  environmentId?: string,
): Promise<EditorCommand | null> {
  const owner = libraryIdentity();
  const changes = projectChanges(base, snapshot);
  if (!changes.length) return null;
  const existing = (await listCommands(snapshot.id)).find(
    (command) =>
      command.status === "pending" &&
      command.baseRevision === base.revision &&
      equal(command.changes, changes),
  );
  if (existing) return existing;
  if (owner !== libraryIdentity())
    throw new Error(
      "제작자 계정이 변경되어 이전 계정의 변경 전송을 중지했습니다.",
    );
  const command: EditorCommand = {
    commandId: crypto.randomUUID(),
    projectId: snapshot.id,
    owner,
    ...(environmentId ? { environmentId } : {}),
    baseRevision: base.revision,
    changes,
    status: "pending",
    createdAt: new Date().toISOString(),
    snapshot: structuredClone(snapshot),
  };
  await libraryTransaction("commands", "readwrite", (store) =>
    store.put(command),
  );
  window.dispatchEvent(new Event("automade:journal"));
  return command;
}
export async function commandState(
  command: EditorCommand,
  status: EditorCommand["status"],
  revision?: number,
  reason?: string,
): Promise<void> {
  if (command.owner !== libraryIdentity()) return;
  await libraryTransaction("commands", "readwrite", (store) =>
    store.put({
      ...command,
      status,
      revision,
      reason,
      ...(["acknowledged", "superseded"].includes(status)
        ? { snapshot: undefined, changes: [] }
        : {}),
    }),
  );
  window.dispatchEvent(new Event("automade:journal"));
}
export async function storageHealth(): Promise<{
  usage: number;
  quota: number;
  persistent: boolean;
}> {
  const estimate = await navigator.storage?.estimate();
  return {
    usage: estimate?.usage || 0,
    quota: estimate?.quota || 0,
    persistent: (await navigator.storage?.persisted()) || false,
  };
}
export async function compactAcknowledgedCommands(): Promise<number> {
  const owner = libraryIdentity(),
    values = await listCommands(),
    remove = values
      .filter((item) => item.status === "acknowledged")
      .slice(0, -100);
  for (const item of remove) {
    if (owner !== libraryIdentity()) break;
    await libraryTransaction("commands", "readwrite", (store) =>
      store.delete(item.commandId),
    );
  }
  return remove.length;
}
