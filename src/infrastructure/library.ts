import { parseProject } from "../domain/validation";
import type { Project } from "../domain/types";
const DB = "automade-studio";
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("projects", { keyPath: "id" });
      db.createObjectStore("backups", { keyPath: "key" });
      db.createObjectStore("evidence", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error(
          "프로젝트 저장소를 열지 못했습니다. 브라우저 저장 권한을 확인하세요.",
        ),
      );
    request.onblocked = () =>
      reject(new Error("다른 탭의 저장소를 닫은 뒤 다시 시도하세요."));
  });
}
async function transaction<T>(
  store: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = operation(tx.objectStore(store));
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () =>
        reject(request.error ?? new Error("저장소 요청 실패"));
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          tx.error ?? new Error("저장에 실패했습니다. 저장 공간을 확인하세요."),
        );
      tx.onerror = () => reject(tx.error ?? new Error("저장소 처리 실패"));
    });
  } finally {
    db.close();
  }
}
export async function listProjects(): Promise<Project[]> {
  const values = await transaction<unknown[]>("projects", "readonly", (s) =>
    s.getAll(),
  );
  return values
    .map(parseProject)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function persistProject(project: Project): Promise<void> {
  const p = parseProject(project);
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["projects", "backups"], "readwrite");
      const store = tx.objectStore("projects");
      const existing = store.get(p.id);
      existing.onsuccess = () => {
        const old = existing.result as Project | undefined;
        if (
          old &&
          (old.revision > p.revision ||
            (old.revision === p.revision &&
              JSON.stringify(old) !== JSON.stringify(p)))
        ) {
          tx.abort();
          reject(
            new Error(
              "다른 탭에서 수정되었습니다. 원본을 내보내고 프로젝트를 다시 여세요.",
            ),
          );
          return;
        }
        if (old && old.revision !== p.revision)
          tx.objectStore("backups").put({
            key: `${old.id}:${old.revision}:${Date.now()}`,
            project: old,
            savedAt: new Date().toISOString(),
          });
        store.put(p);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          new Error("자동 저장에 실패했습니다. 프로젝트 파일을 내보내세요."),
        );
      tx.onerror = () => reject(tx.error ?? new Error("자동 저장 실패"));
    });
  } finally {
    db.close();
  }
}
export async function recoverProjects(projectId: string): Promise<Project[]> {
  const values = await transaction<Array<{ project: unknown }>>(
    "backups",
    "readonly",
    (s) => s.getAll(),
  );
  return values
    .map((x) => parseProject(x.project))
    .filter((x) => x.id === projectId)
    .sort((a, b) => b.revision - a.revision);
}
export async function preserveEvidence(
  raw: string,
  source: string,
): Promise<void> {
  await transaction("evidence", "readwrite", (s) =>
    s.put({
      key: `${source}:${Date.now()}`,
      raw,
      source,
      savedAt: new Date().toISOString(),
    }),
  );
}
export async function importLegacy(): Promise<Project | null> {
  const raw = localStorage.getItem("interface-auto-builder.project");
  if (!raw || localStorage.getItem("automade-legacy-imported")) return null;
  await preserveEvidence(raw, "legacy-localStorage");
  const project = parseProject(JSON.parse(raw) as unknown);
  await persistProject(project);
  localStorage.setItem("automade-legacy-imported", "true");
  return project;
}
export function downloadFile(
  name: string,
  contents: string,
  type = "application/json",
): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
