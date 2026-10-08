import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, Row } from "../src/domain/types";
import { parseProject, parseRows, record } from "../src/domain/validation";
import { MIGRATION_2, OperationsStore } from "./operationsStore";
import { PLATFORM_MIGRATION } from "./platform/schema";
import { TABLE_HISTORY_MIGRATION } from "./tableHistory";
import { EXPANSION_MIGRATION } from "./expansion/schema";
import { WORK_MIGRATION } from "./workQueue";
import { EXPANSION_BUSINESS_MIGRATION } from "./expansion/businessSchema";
import { EXPANSION_SECURITY_MIGRATION } from "./expansion/securitySchema";
import { SYSTEM_MIGRATION } from "./advancement/schema";
import { CONTENT_MIGRATION } from "./advancement/contentSchema";
import { SECURITY_MIGRATION } from "./advancement/securitySchema";
import { RUNTIME_MIGRATION } from "./runtimeSchema";
import {OPERATION_MIGRATION} from './operationSchema';
import {ASSET_USAGE_MIGRATION} from './advancement/assetSchema';
import {BOOKING_ADVANCEMENT_MIGRATION} from './advancement/bookingSchema';
import { HttpError } from "./http";
import type { CommandAcknowledgement } from "./projectCommands";
function stableObject(_key:string,value:unknown):unknown {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left],[right])=>left.localeCompare(right)))
    : value;
}
export class ConflictError extends Error {
  code = "CONFLICT";
}
export const MIGRATION_1 = `CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0),body TEXT NOT NULL CHECK(json_valid(body)),updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_backups(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS backups_project ON project_backups(project_id,revision DESC);
CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,directory TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('building','ready','failed')),created_at TEXT NOT NULL,error_code TEXT);
CREATE INDEX IF NOT EXISTS exports_project ON exports(project_id,created_at DESC);
CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,block_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,UNIQUE(block_id,idempotency_key));
CREATE INDEX IF NOT EXISTS submissions_block ON submissions(block_id,created_at DESC);
CREATE TABLE IF NOT EXISTS table_data(block_id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>=0),body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,operation TEXT NOT NULL,resource_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);`;
export class Store {
  readonly db: DatabaseSync;
  readonly operations: OperationsStore;
  projectHydrator: (project: Project) => Project = project => project;
  beforeProjectWrite: (previous: Project | null, incoming: Project) => Project = (_previous, incoming) => incoming;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)",
    );
    const applied=Number(this.db.prepare("SELECT COUNT(*) AS count FROM migrations").get()?.count??0);
    if(path!==":memory:"&&applied>0&&[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15].some(version=>!this.db.prepare("SELECT version FROM migrations WHERE version=?").get(version))){
      const backup=path+".before-upgrade-"+new Date().toISOString().replaceAll(":","-")+"-"+randomUUID()+".sqlite";
      try{this.db.prepare("VACUUM INTO ?").run(backup);}catch(error){this.db.close();throw error;}
    }
    for (const [index, migration] of [MIGRATION_1, MIGRATION_2, PLATFORM_MIGRATION, TABLE_HISTORY_MIGRATION, EXPANSION_MIGRATION, WORK_MIGRATION, EXPANSION_BUSINESS_MIGRATION, EXPANSION_SECURITY_MIGRATION,SYSTEM_MIGRATION,CONTENT_MIGRATION,SECURITY_MIGRATION,RUNTIME_MIGRATION,OPERATION_MIGRATION,ASSET_USAGE_MIGRATION,BOOKING_ADVANCEMENT_MIGRATION].entries()) {
      const version = index + 1;
      if (this.db.prepare("SELECT version FROM migrations WHERE version=?").get(version)) continue;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(migration);
        this.db
          .prepare("INSERT INTO migrations(version,applied_at) VALUES(?,?)")
          .run(version, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        this.db.close();
        throw error;
      }
    }
    this.operations = new OperationsStore(this.db);
  }
  close(): void {
    this.db.close();
  }
  projects(): Project[] {
    return this.db
      .prepare("SELECT body FROM projects ORDER BY updated_at DESC LIMIT 1000")
      .all()
      .map((row) => this.projectHydrator(parseProject(JSON.parse(String(row.body)) as unknown)));
  }
  project(id: string): Project | null {
    const raw = this.rawProject(id);
    return raw ? this.projectHydrator(raw) : null;
  }
  rawProject(id: string): Project | null {
    const row = this.db.prepare("SELECT body FROM projects WHERE id=?").get(id);
    return row ? parseProject(JSON.parse(String(row.body)) as unknown) : null;
  }
  save(project: Project, baseRevision?: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.writeProject(project, baseRevision);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private writeProject(incoming: Project, baseRevision?: number): Project {
      const existing = this.rawProject(incoming.id);
      const comparable = existing ? this.projectHydrator(existing) : null;
      const project = this.beforeProjectWrite(existing, incoming);
      if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || baseRevision < -1 || (existing?.revision ?? -1) !== baseRevision))
        throw new ConflictError("다른 저장본이 변경되었습니다. 마지막 동기화본과 비교한 뒤 병합하세요.");
      if (existing && existing.revision > project.revision)
        throw new ConflictError(
          "다른 저장본이 더 최신입니다. 프로젝트를 다시 불러오세요.",
        );
      if (
        existing &&
        existing.revision === project.revision &&
        JSON.stringify(comparable, stableObject) !== JSON.stringify(project, stableObject)
      )
        throw new ConflictError(
          "동일한 버전의 내용이 충돌합니다. 복제하여 저장하세요.",
        );
      if (existing && existing.revision !== project.revision)
        this.db
          .prepare("INSERT INTO project_backups VALUES(?,?,?,?,?)")
          .run(
            randomUUID(),
            project.id,
            existing.revision,
            JSON.stringify(existing),
            new Date().toISOString(),
          );
      this.db
        .prepare(
          "INSERT INTO projects VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body,updated_at=excluded.updated_at",
        )
        .run(
          project.id,
          project.revision,
          JSON.stringify(project),
          project.updatedAt,
        );
      this.audit("project.save", project.id, "success");
      return project;
  }
  saveCommand(projectId: string, actorKey: string, commandId: string, fingerprint: string, prepare: (current: Project) => Project): CommandAcknowledgement {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT fingerprint,result FROM system_command_receipts WHERE actor_key=? AND project_id=? AND command_id=?").get(actorKey,projectId,commandId);
      if(previous){
        if(previous.fingerprint!==fingerprint)throw new HttpError(409,"COMMAND_IDEMPOTENCY","같은 명령 식별자의 내용이 다릅니다.");
        const value = record(JSON.parse(String(previous.result)) as unknown);
        const result:CommandAcknowledgement={commandId,revision:Number(value.revision),project:parseProject(value.project),ack:true,status:"applied",replayed:true};
        this.db.exec("COMMIT");return result;
      }
      const current=this.project(projectId);if(!current)throw new HttpError(404,"PROJECT_NOT_FOUND","명령 대상 원본이 없습니다.");
      const candidate=prepare(current);if(candidate.id!==projectId)throw new HttpError(403,"COMMAND_PROJECT","명령 범위를 확인하세요.");
      const saved=this.writeProject(candidate,current.revision),canonical=this.project(projectId)??saved;
      const result:CommandAcknowledgement={commandId,revision:canonical.revision,project:canonical,ack:true,status:"applied",replayed:false};
      this.db.prepare("INSERT INTO system_command_receipts VALUES(?,?,?,?,?,?,?)").run(actorKey,projectId,commandId,fingerprint,result.revision,JSON.stringify(result),Date.now());
      this.db.exec("COMMIT");return result;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  commandReceipts(projectId:string,actorKey:string,ids:string[]):{commandId:string;revision:number;ack:true;status:"applied"}[]{
    if(ids.length>100||ids.some(id=>! /^[a-zA-Z0-9_-]{1,100}$/.test(id)))throw new HttpError(400,"COMMAND_IDS","명령 식별자는 최대100개입니다.");
    return ids.flatMap(id=>{const row=this.db.prepare("SELECT revision FROM system_command_receipts WHERE actor_key=? AND project_id=? AND command_id=?").get(actorKey,projectId,id);return row?[{commandId:id,revision:Number(row.revision),ack:true as const,status:"applied" as const}]:[];});
  }
  backups(id: string): Project[] {
    return this.db
      .prepare(
        "SELECT body FROM project_backups WHERE project_id=? ORDER BY revision DESC LIMIT 100",
      )
      .all(id)
      .map((row) => parseProject(JSON.parse(String(row.body)) as unknown));
  }
  audit(operation: string, resourceId: string, status: string): void {
    this.db
      .prepare("INSERT INTO audit VALUES(?,?,?,?,?)")
      .run(
        randomUUID(),
        operation,
        resourceId,
        status,
        new Date().toISOString(),
      );
  }
  audits(): unknown[] {
    return this.db
      .prepare("SELECT * FROM audit ORDER BY created_at DESC LIMIT 100")
      .all();
  }
  exportStart(id: string, projectId: string): void {
    this.db
      .prepare("INSERT INTO exports VALUES(?,?,?,?,?,NULL)")
      .run(id, projectId, "", "building", new Date().toISOString());
  }
  exportDone(id: string, directory: string, error?: string): void {
    this.db
      .prepare(
        "UPDATE exports SET directory=?,status=?,error_code=? WHERE id=?",
      )
      .run(directory, error ? "failed" : "ready", error ?? null, id);
  }
  recoverInterrupted(): void {
    this.operations.recover();
    this.db
      .prepare(
        "UPDATE exports SET status=\x27failed\x27,error_code=\x27PROCESS_INTERRUPTED\x27 WHERE status=\x27building\x27 AND NOT EXISTS(SELECT 1 FROM resource_leases l WHERE l.resource='generation:'||exports.project_id AND l.expires_at>?)",
      )
      .run(Date.now());
  }
  exports(): unknown[] {
    return this.db
      .prepare(
        "SELECT id,project_id,status,created_at,error_code FROM exports ORDER BY created_at DESC LIMIT 100",
      )
      .all();
  }
  exportRecord(id: string): {
    id: string;
    project_id: string;
    directory: string;
    status: string;
  } | null {
    const row = this.db
      .prepare("SELECT id,project_id,directory,status FROM exports WHERE id=?")
      .get(id);
    return row
      ? {
          id: String(row.id),
          project_id: String(row.project_id),
          directory: String(row.directory),
          status: String(row.status),
        }
      : null;
  }
  latestDirectory(projectId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT directory FROM exports WHERE project_id=? AND status='ready' ORDER BY created_at DESC LIMIT 1",
      )
      .get(projectId);
    return row ? String(row.directory) : null;
  }
  submit(
    blockId: string,
    key: string,
    values: Record<string, string>,
  ): { id: string; createdAt: string } {
    const existing = this.db
      .prepare(
        "SELECT id,created_at,body FROM submissions WHERE block_id=? AND idempotency_key=?",
      )
      .get(blockId, key);
    if (existing) {
      if (String(existing.body) !== JSON.stringify(values))
        throw new ConflictError("동일한 요청 키의 입력 내용이 다릅니다.");
      return {
        id: String(existing.id),
        createdAt: String(existing.created_at),
      };
    }
    const id = randomUUID(),
      createdAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO submissions VALUES(?,?,?,?,?)")
      .run(id, blockId, key, JSON.stringify(values), createdAt);
    this.audit("form.submit", blockId, "success");
    return { id, createdAt };
  }
  submissions(limit = 50, offset = 0): unknown[] {
    return this.db
      .prepare(
        "SELECT id,block_id,body,created_at FROM submissions ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset)
      .map((row) => ({
        ...row,
        values: JSON.parse(String(row.body)) as unknown,
        body: undefined,
      }));
  }
  table(
    blockId: string,
    initial: Row[],
    columns: number,
  ): { rows: Row[]; version: number } {
    const row = this.db
      .prepare("SELECT version,body FROM table_data WHERE block_id=?")
      .get(blockId);
    return row
      ? {
          rows: parseRows(JSON.parse(String(row.body)) as unknown, columns),
          version: Number(row.version),
        }
      : { rows: initial, version: 0 };
  }
  saveTable(blockId: string, rows: Row[], expectedVersion: number): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT version FROM table_data WHERE block_id=?")
        .get(blockId);
      const version = Number(old?.version ?? 0);
      if (version !== expectedVersion)
        throw new ConflictError(
          "다른 창에서 표를 수정했습니다. 새로고침 후 다시 시도하세요.",
        );
      this.db
        .prepare(
          "INSERT INTO table_data VALUES(?,?,?) ON CONFLICT(block_id) DO UPDATE SET version=excluded.version,body=excluded.body",
        )
        .run(blockId, version + 1, JSON.stringify(rows));
      this.audit("table.save", blockId, "success");
      this.db.exec("COMMIT");
      return version + 1;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  snapshot(target: string): void {
    this.db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  }
  activeRelease(): string | null { return this.operations.activeRelease(); }
  activateRelease(id: string): void { this.operations.setState("activeRelease", id); }
  pauseProjectWrites(paused: boolean): void { this.operations.setState("writesPaused", paused); }
  assertWritable(releaseId?: string): void { this.operations.assertWritable(releaseId); }
  stats(): Record<string, number> {
    return record({
      projects: this.db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n,
      exports: this.db.prepare("SELECT COUNT(*) AS n FROM exports").get()?.n,
      submissions: this.db
        .prepare("SELECT COUNT(*) AS n FROM submissions")
        .get()?.n,
    }) as Record<string, number>;
  }
}
