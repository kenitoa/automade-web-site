import { lstat, mkdir, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store";
import { contained, HttpError } from "./http";
import { record } from "../src/domain/validation";
import type { RetentionPolicy } from "../src/domain/operations";
import { ResourceLeases } from "./workQueue";
export interface RetentionCandidate { id: string; kind: "artifact" | "staging" | "backup"; resourceId: string; createdAt: string; bytes: number; label: string; relativePath: string; }
interface InternalCandidate extends RetentionCandidate { original: string; root: "exports" | "data"; }
interface QuarantineRecord { id: string; projectId: string; candidate: InternalCandidate; quarantine: string; status: "moving" | "quarantined" | "restored" | "failed"; createdAt: string; restoredAt?: string; errorCode?: string; }
export interface RetentionPreview { policy: RetentionPolicy; candidates: RetentionCandidate[]; protectedCount: number; bytes: number; warning: boolean; quarantined: number; overdueAuditRecords: number; overdueSubmissions: number; errors: string[]; }
const validId = /^[a-zA-Z0-9_-]{1,100}$/;
const normalized = (value: string): string => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
const older = (created: string, days: number): boolean => Number.isFinite(Date.parse(created)) && Date.parse(created) < Date.now() - days * 86400_000;
export class RetentionService {
  private reservations = new Map<string, number>();
  private running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private worker: Promise<void> | null = null;
  private closed = false;
  constructor(private store: Store, private exportRoot: string, private dataRoot: string, private protectedReleases: () => Set<string>, private projectBusy: (project: string) => boolean = () => false) {}
  reserveRelease(id: string): () => void { const lease=new ResourceLeases(this.store.db).acquire(`artifact:${id}`,randomUUID(),"shared",300_000); try{this.assertAvailable(id);}catch(error){lease.release();throw error;} this.reservations.set(id, (this.reservations.get(id) ?? 0) + 1); let done = false; return () => { if (done) return; done = true; lease.release();const left = (this.reservations.get(id) ?? 1) - 1; if (left) this.reservations.set(id, left); else this.reservations.delete(id); }; }
  assertAvailable(id: string): void {
    const entries = this.store.db.prepare("SELECT value FROM runtime_state WHERE key LIKE 'retention:quarantine:%'").all();
    for (const row of entries) {
      const value = JSON.parse(String(row.value)) as QuarantineRecord[];
      if (value.some((entry) => entry.candidate.resourceId === id && entry.candidate.kind !== "backup" && ["moving", "quarantined"].includes(entry.status))) throw new HttpError(409, "ARTIFACT_QUARANTINED", "격리 보관 중인 결과입니다. 보존 관리에서 복원한 뒤 사용하세요.");
    }
  }
  private records(project: string): QuarantineRecord[] {
    const value = this.store.operations.state(`retention:quarantine:${project}`);
    return Array.isArray(value) ? value as QuarantineRecord[] : [];
  }
  private saveRecords(project: string, values: QuarantineRecord[]): void { this.store.operations.setState(`retention:quarantine:${project}`, values); }
  private root(kind: "exports" | "data"): string { return kind === "exports" ? this.exportRoot : this.dataRoot; }
  private async safe(root: string, target: string): Promise<string> {
    const resolvedRoot = await realpath(root), resolved = await realpath(target);
    const relative = path.relative(path.resolve(root), path.resolve(target));
    if (!contained(root, target) || !contained(resolvedRoot, resolved) || relative.startsWith("..") || (await lstat(target)).isSymbolicLink() || normalized(resolved) !== normalized(path.join(resolvedRoot, relative))) throw new HttpError(403, "RETENTION_PATH", "허용된 저장소 내부의 실제 파일·폴더만 정리할 수 있습니다.");
    return resolved;
  }
  private async directory(root: string, destination: string): Promise<void> {
    if (!contained(root, destination)) throw new HttpError(403, "RETENTION_PATH", "저장소 내부의 폴더만 생성할 수 있습니다.");
    const parts = path.relative(path.resolve(root), path.resolve(destination)).split(path.sep); let current = root;
    for (const part of parts) {
      if (!part || part === "." || part === "..") throw new HttpError(403, "RETENTION_PATH", "폴더 경로를 확인하세요.");
      if (normalized(path.resolve(current)) !== normalized(path.resolve(root))) await this.safe(root, current); else await realpath(root);
      const next = path.join(current, part);
      try { await lstat(next); await this.safe(root, next); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(next); await this.safe(root, next); }
      current = next;
    }
  }
  private async bytes(root: string, target: string): Promise<number> {
    const safe = await this.safe(root, target), info = await lstat(safe);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) throw new HttpError(403, "RETENTION_PATH", "일반 파일·폴더만 정리할 수 있습니다.");
    let total = 0;
    for (const entry of await readdir(safe, { withFileTypes: true })) { if (entry.isSymbolicLink()) throw new HttpError(403, "RETENTION_SYMLINK", "연결 파일이 있는 폴더는 자동 정리하지 않습니다."); total += await this.bytes(root, path.join(safe, entry.name)); }
    return total;
  }
  private protected(id: string, project: string): boolean { const referenced=this.store.db.prepare("SELECT 1 FROM system_release_activations a JOIN exports e ON e.id=a.id WHERE a.source_release_id=? AND e.status='ready' LIMIT 1").get(id);const alias=this.store.db.prepare("SELECT 1 FROM system_release_activations WHERE id=? AND status IN('preparing','ready') LIMIT 1").get(id);return Boolean(referenced||alias)||this.projectBusy(project) || this.reservations.has(id) || this.protectedReleases().has(id) || this.store.operations.projectRelease(project) === id; }
  private async inspect(project: string): Promise<{ preview: RetentionPreview; internal: InternalCandidate[] }> {
    if (!validId.test(project) || !this.store.project(project)) throw new HttpError(404, "PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
    const policy = this.store.operations.retention(project), records = this.records(project), internal: InternalCandidate[] = [], errors: string[] = [];
    let protectedCount = 0, total = 0;
    const removed = new Set(records.filter((entry) => ["moving", "quarantined"].includes(entry.status)).map((entry) => entry.candidate.id));
    const releases = this.store.db.prepare("SELECT id,directory,status,created_at FROM exports WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 2000").all(project);
    let keptReleases = 0;
    for (const row of releases) {
      const id = String(row.id); if (!validId.test(id)) continue;
      const kind = row.status === "ready" ? "artifact" : "staging", key = `${kind}:${id}`;
      if (removed.has(key)) continue;
      const original = kind === "artifact" ? String(row.directory) : path.join(this.exportRoot, `.${id}.staging`);
      if (path.resolve(original) !== path.resolve(this.exportRoot, kind === "artifact" ? id : `.${id}.staging`)) { errors.push(`${id}: 예상 저장 경로가 아닙니다.`); continue; }
      try {
        const bytes = await this.bytes(this.exportRoot, original); total += bytes;
        const latest = row.status === "ready" && keptReleases++ < 2;
        if (row.status === "building" || this.protected(id, project) || latest || !older(String(row.created_at), policy.artifactDays)) { protectedCount++; continue; }
        internal.push({ id: key, resourceId: id, kind, createdAt: String(row.created_at), bytes, label: kind === "artifact" ? "이전 사이트 결과" : "실패한 생성 작업 폴더", relativePath: path.relative(this.exportRoot, original), original, root: "exports" });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${id}: 경로 또는 파일 검증에 실패했습니다.`); }
    }
    const backups = this.store.db.prepare("SELECT id,file,created_at FROM data_backups WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 2000").all(project);
    let keptBackups = 0;
    for (const row of backups) {
      const id = String(row.id), key = `backup:${id}`; if (!validId.test(id) || removed.has(key)) continue;
      const original = String(row.file), expected = path.join(this.dataRoot, "backups", project, `${id}.sqlite`);
      if (path.resolve(original) !== path.resolve(expected)) { errors.push(`${id}: 예상 백업 경로가 아닙니다.`); continue; }
      try { const bytes = await this.bytes(this.dataRoot, original); total += bytes; if (keptBackups++ < 2 || this.reservations.has(id) || this.projectBusy(project) || !older(String(row.created_at), policy.backupDays)) { protectedCount++; continue; } internal.push({ id: key, resourceId: id, kind: "backup", createdAt: String(row.created_at), bytes, label: "이전 운영 데이터 백업", relativePath: path.relative(this.dataRoot, original), original, root: "data" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${id}: 백업 경로 또는 파일 검증에 실패했습니다.`); }
    }
    for (const target of [path.join(this.dataRoot, "sites", project), path.join(this.dataRoot, ".quarantine", project), path.join(this.exportRoot, ".quarantine", project)]) { try { total += await this.bytes(target.startsWith(this.exportRoot + path.sep) ? this.exportRoot : this.dataRoot, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push("현재 데이터·격리 저장소의 용량을 확인하지 못했습니다."); } }
    const overdueAuditRecords = Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE resource_id=? AND created_at<?").get(project, new Date(Date.now() - policy.auditDays * 86400_000).toISOString())?.n ?? 0);
    // Operational records stay in the canonical database: retention is reversible, never destructive SQL.
    let overdueSubmissions = 0;
    const canonical = path.join(this.dataRoot, "sites", project, "site.sqlite");
    try { await this.safe(this.dataRoot, canonical); const { DatabaseSync } = await import("node:sqlite"); const db = new DatabaseSync(canonical, { readOnly: true }); try { overdueSubmissions = Number(db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE created_at<?").get(new Date(Date.now() - policy.submissionDays * 86400_000).toISOString())?.n ?? 0); } finally { db.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push("문의 보존 기준 집계를 확인하지 못했습니다."); }
    return { internal, preview: { policy, candidates: internal.map(({ original: _original, root: _root, ...candidate }) => candidate), protectedCount, bytes: total, warning: total > policy.maxStorageMB * 1024 * 1024, quarantined: records.filter((entry) => entry.status === "quarantined").length, overdueAuditRecords, overdueSubmissions, errors } };
  }
  async preview(project: string): Promise<RetentionPreview> { return (await this.inspect(project)).preview; }
  list(project: string): Array<Omit<QuarantineRecord, "candidate" | "quarantine"> & { candidate: RetentionCandidate }> { return this.records(project).map(({ quarantine: _path, candidate: { original: _original, root: _root, ...candidate }, ...entry }) => ({ ...entry, candidate })); }
  async quarantine(project: string, selected?: string[]): Promise<{ moved: number; skipped: string[] }> {
    if (this.running.has(project)) throw new HttpError(409, "RETENTION_BUSY", "이 사이트의 보존 작업을 처리 중입니다.");
    if (selected && (selected.length > 100 || selected.some((id) => typeof id !== "string" || id.length > 150))) throw new HttpError(400, "RETENTION_SELECTION", "정리 대상은 한 번에 최대 100개입니다.");
    this.running.add(project);
    try {
      const inspected = await this.inspect(project), wanted = selected ? new Set(selected) : null, failed = new Set(this.records(project).filter((entry) => entry.status === "failed").map((entry) => entry.candidate.id)), candidates = inspected.internal.filter((candidate) => wanted ? wanted.has(candidate.id) : !failed.has(candidate.id)).slice(0, 100);
      const skipped = selected?.filter((id) => !candidates.some((candidate) => candidate.id === id)) ?? []; let moved = 0;
      for (const candidate of candidates) {
        if (this.reservations.has(candidate.resourceId) || this.projectBusy(project) || (candidate.kind !== "backup" && this.protected(candidate.resourceId, project))) { skipped.push(candidate.id); continue; }
        const base = this.root(candidate.root), id = randomUUID(), folder = path.join(base, ".quarantine", project, id), destination = path.join(folder, candidate.kind === "backup" ? "backup.sqlite" : "artifact");
        await this.directory(base, folder); const source = await this.safe(base, candidate.original);
        if (this.reservations.has(candidate.resourceId) || this.projectBusy(project) || (candidate.kind !== "backup" && this.protected(candidate.resourceId, project))) { skipped.push(candidate.id); continue; }
        const records = this.records(project), entry: QuarantineRecord = { id, projectId: project, candidate, quarantine: destination, status: "moving", createdAt: new Date().toISOString() }; records.push(entry); this.saveRecords(project, records);
        const leases=new ResourceLeases(this.store.db);
        let lease:ReturnType<ResourceLeases["acquire"]>|undefined;
        try { lease=leases.acquire(`${candidate.kind==="backup"?"backup":"artifact"}:${candidate.resourceId}`,id,"exclusive",300_000);lease.assertCurrent();await rename(source, destination);lease.assertCurrent(); entry.status = "quarantined"; this.saveRecords(project, records); this.store.audit("retention.quarantine", project, "success"); moved++; }
        catch (error) { entry.status = "failed"; entry.errorCode = "MOVE_FAILED"; this.saveRecords(project, records); this.store.audit("retention.quarantine", project, "failed"); if (error instanceof HttpError) throw error; skipped.push(candidate.id); }
        finally {lease?.release();}
      }
      return { moved, skipped };
    } finally { this.running.delete(project); }
  }
  async restore(project: string, id: string): Promise<{ restored: boolean }> {
    if (!validId.test(project) || !validId.test(id)) throw new HttpError(400, "RETENTION_ID", "복원 대상을 확인하세요.");
    if (this.running.has(project) || this.projectBusy(project)) throw new HttpError(409, "RETENTION_BUSY", "진행 중인 작업이 끝난 뒤 복원하세요.");
    this.running.add(project);
    try {
      const records = this.records(project), entry = records.find((entry) => entry.id === id);
      if (!entry || entry.status !== "quarantined") throw new HttpError(404, "QUARANTINE", "격리 보관 중인 항목을 찾을 수 없습니다.");
      const base = this.root(entry.candidate.root), source = await this.safe(base, entry.quarantine), parent = path.dirname(entry.candidate.original);
      if (normalized(path.resolve(parent)) !== normalized(path.resolve(base))) await this.directory(base, parent); else await realpath(base);
      try { await lstat(entry.candidate.original); throw new HttpError(409, "RESTORE_EXISTS", "원래 위치에 파일이 있어 덮어쓸 수 없습니다."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(source, entry.candidate.original); entry.status = "restored"; entry.restoredAt = new Date().toISOString(); this.saveRecords(project, records); this.store.audit("retention.restore", project, "success"); return { restored: true };
    } finally { this.running.delete(project); }
  }
  async recover(): Promise<void> {
    for (const project of this.store.projects()) {
      const records = this.records(project.id); let changed = false;
      for (const entry of records.filter((entry) => entry.status === "moving")) {
        try { await this.safe(this.root(entry.candidate.root), entry.quarantine); entry.status = "quarantined"; }
        catch (error) { entry.status = "failed"; entry.errorCode = (error as NodeJS.ErrnoException).code === "ENOENT" ? "MOVE_INTERRUPTED" : "PATH_REJECTED"; }
        changed = true;
      }
      if (changed) this.saveRecords(project.id, records);
    }
  }
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    const tick = (): void => { if (this.closed || this.worker) return; this.worker = this.runAutomatic().catch((error: unknown) => { console.error(JSON.stringify({ operation: "retention.worker", errorCode: error instanceof HttpError ? error.code : "RETENTION_ERROR" })); }).finally(() => { this.worker = null; }); };
    this.timer = setInterval(tick, intervalMs); this.timer.unref(); tick();
  }
  async runAutomatic(): Promise<void> {
    await this.recover();
    for (const project of this.store.projects()) if (this.store.operations.retention(project.id).automaticCleanup && !this.projectBusy(project.id) && !this.running.has(project.id)) await this.quarantine(project.id);
  }
  async policyChanged(project: string): Promise<void> { if (this.store.operations.retention(project).automaticCleanup) await this.quarantine(project); }
  async close(): Promise<void> { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; if (this.worker) await this.worker; }
  async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL): Promise<boolean> {
    const route = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/retention(?:\/(preview|quarantine|quarantines)(?:\/([a-zA-Z0-9_-]+)\/restore)?)?$/);
    if (!route) return false;
    const project = route[1]!, action = route[2], id = route[3]; if (!this.store.project(project)) throw new HttpError(404, "PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
    const { body, reply } = await import("./http");
    if (!action && req.method === "GET") reply(res, 200, this.store.operations.retention(project));
    else if (!action && req.method === "PUT") { const policy = this.store.operations.saveRetention(project, await body(req, 10000)); await this.policyChanged(project); reply(res, 200, policy); }
    else if (action === "preview" && req.method === "GET") reply(res, 200, await this.preview(project));
    else if (action === "quarantines" && !id && req.method === "GET") reply(res, 200, this.list(project));
    else if (action === "quarantine" && req.method === "POST") { const input = record(await body(req, 20000)); if (!Array.isArray(input.candidateIds)) throw new HttpError(400, "RETENTION_SELECTION", "미리보기에서 정리할 대상을 선택하세요."); reply(res, 200, await this.quarantine(project, input.candidateIds as string[])); }
    else if (action === "quarantines" && id && req.method === "POST") reply(res, 200, await this.restore(project, id));
    else throw new HttpError(405, "METHOD", "지원하지 않는 보존 요청입니다.");
    return true;
  }
}
