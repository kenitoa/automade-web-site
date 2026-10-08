import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ExportResult, Project } from "../src/domain/types";
import type { DataBackup, JobStatus, RetentionPolicy, SubmissionEntry, SubmissionPage, SubmissionStatus, OperationMetric } from "../src/domain/operations";
import { record } from "../src/domain/validation";
import { HttpError } from "./http";

export const MIGRATION_2 = `CREATE TABLE generation_jobs(id TEXT PRIMARY KEY REFERENCES exports(id), project_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), project_body TEXT NOT NULL CHECK(json_valid(project_body)), status TEXT NOT NULL CHECK(status IN('building','ready','failed','cancelled')), stage TEXT NOT NULL, checkpoints TEXT NOT NULL CHECK(json_valid(checkpoints)), result TEXT CHECK(result IS NULL OR json_valid(result)), error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,request_key));
CREATE INDEX generation_project ON generation_jobs(project_id,created_at DESC);
CREATE TABLE project_runtime(project_id TEXT PRIMARY KEY, active_release_id TEXT, updated_at TEXT NOT NULL);
CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value TEXT NOT NULL CHECK(json_valid(value)));
CREATE TABLE submission_workflow(submission_id TEXT PRIMARY KEY REFERENCES submissions(id),status TEXT NOT NULL DEFAULT 'new' CHECK(status IN('new','processing','completed','archived')),tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags)),note TEXT NOT NULL DEFAULT '',assignee TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
CREATE TABLE data_backups(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,release_id TEXT,file TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>=0),reason TEXT NOT NULL,submissions INTEGER NOT NULL,tables_count INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX data_backups_project ON data_backups(project_id,created_at DESC);
CREATE TABLE retention_policies(project_id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE telemetry(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL,duration_ms INTEGER NOT NULL CHECK(duration_ms>=0),created_at TEXT NOT NULL);
CREATE INDEX telemetry_project ON telemetry(project_id,created_at DESC);`;
export interface SavedJob {
  id: string; projectId: string; revision: number; status: JobStatus; stage: string;
  checkpoints: { stage: string; at: string }[]; createdAt: string; updatedAt: string;
  result?: ExportResult; error?: string; errorCode?: string; retryable: boolean;
}
export interface SubmissionFilter { limit: number; offset: number; query?: string; status?: string; blockId?: string; from?: string; to?: string }
export const DEFAULT_RETENTION: RetentionPolicy = { backupDays: 90, artifactDays: 90, auditDays: 365, submissionDays: 365, maxStorageMB: 1024, automaticCleanup: false };
const parsed = (value: unknown): unknown => JSON.parse(String(value)) as unknown;
export class OperationsStore {
  constructor(readonly db: DatabaseSync) {}
  createJob(id: string, project: Project, key: string, fingerprint: string): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO exports VALUES(?,?,?,?,?,NULL)").run(id, project.id, "", "building", now);
      this.db.prepare("INSERT INTO generation_jobs VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)").run(id, project.id, key, fingerprint, project.revision, JSON.stringify(project), "building", "프로젝트 검사", JSON.stringify([{ stage: "프로젝트 검사", at: now }]), now, now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  request(projectId: string, key: string): {id:string;fingerprint:string} | null {
    const row = this.db.prepare("SELECT id,fingerprint FROM generation_jobs WHERE project_id=? AND request_key=?").get(projectId,key);
    return row ? {id:String(row.id),fingerprint:String(row.fingerprint)} : null;
  }
  job(id: string): SavedJob | null {
    const row = this.db.prepare("SELECT * FROM generation_jobs WHERE id=?").get(id);
    if (!row) return null;
    return { id, projectId:String(row.project_id), revision:Number(row.revision), status:String(row.status) as JobStatus, stage:String(row.stage), checkpoints:parsed(row.checkpoints) as SavedJob["checkpoints"], createdAt:String(row.created_at), updatedAt:String(row.updated_at), ...(row.result ? {result:parsed(row.result) as ExportResult} : {}), ...(row.error_message ? {error:String(row.error_message)} : {}), ...(row.error_code ? {errorCode:String(row.error_code)} : {}), retryable:row.status === "failed" || row.status === "cancelled" };
  }
  jobProject(id: string): unknown {
    const row=this.db.prepare("SELECT project_body FROM generation_jobs WHERE id=?").get(id);
    if (!row) throw new HttpError(404,"JOB_NOT_FOUND","생성 작업을 찾을 수 없습니다.");
    return parsed(row.project_body);
  }
  stage(id: string, stage: string): void {
    const job=this.job(id);
    if (!job) return;
    const now=new Date().toISOString();
    const checkpoints=[...job.checkpoints,{stage,at:now}].slice(-30);
    this.db.prepare("UPDATE generation_jobs SET stage=?,checkpoints=?,updated_at=? WHERE id=?").run(stage,JSON.stringify(checkpoints),now,id);
  }
  finish(id: string,status: JobStatus, result?:ExportResult,errorCode?:string,error?:string): void {
    const now=new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE generation_jobs SET status=?,stage=?,result=?,error_code=?,error_message=?,updated_at=? WHERE id=?").run(status,status === "ready" ? "완료" : status === "cancelled" ? "취소 완료" : "실패",result ? JSON.stringify(result):null,errorCode??null,error??null,now,id);
      this.db.prepare("UPDATE exports SET directory=?,status=?,error_code=? WHERE id=?").run(result?.path??"",status === "ready"?"ready":"failed",errorCode??null,id);
      this.db.exec("COMMIT");
    } catch (cause) {this.db.exec("ROLLBACK");throw cause;}
  }
  recover(): void {
    this.db.prepare("UPDATE generation_jobs SET status='failed',stage='서버 재시작으로 중단',error_code='PROCESS_INTERRUPTED',error_message='서버가 재시작되어 생성을 중단했습니다. 원본으로 다시 시도하세요.',updated_at=? WHERE status='building' AND NOT EXISTS(SELECT 1 FROM resource_leases l WHERE l.resource='generation:'||generation_jobs.project_id AND l.expires_at>?)").run(new Date().toISOString(),Date.now());
  }
  activateProject(projectId:string,releaseId:string): void {
    this.db.prepare("INSERT INTO project_runtime VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET active_release_id=excluded.active_release_id,updated_at=excluded.updated_at").run(projectId,releaseId,new Date().toISOString());
  }
  projectRelease(projectId:string):string|null {
    const row=this.db.prepare("SELECT active_release_id FROM project_runtime WHERE project_id=?").get(projectId);
    return row?.active_release_id ? String(row.active_release_id) : null;
  }
  state(key:string):unknown {
    const row=this.db.prepare("SELECT value FROM runtime_state WHERE key=?").get(key);
    return row?parsed(row.value):null;
  }
  setState(key:string,value:unknown):void {
    this.db.prepare("INSERT INTO runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,JSON.stringify(value));
  }
  activeRelease():string|null {const value=this.state("activeRelease");return typeof value === "string"?value:null;}
  assertWritable(releaseId?:string):void {
    if (this.state("writesPaused") === true) throw new HttpError(409,"SITE_PAUSED","데이터 보존 중입니다. 잠시 후 다시 제출하세요.");
    const active=this.activeRelease();
    if (releaseId && active && active !== releaseId) throw new HttpError(409,"SITE_REPLACED","이전 생성본은 읽기 전용입니다. 최신 사이트를 열어 입력하세요.");
  }
  submissions(filter:SubmissionFilter):SubmissionPage {
    const conditions:string[]=[], params:(string|number)[]=[];
    if(filter.query){conditions.push("s.body LIKE ? ESCAPE '\\'");params.push("%"+filter.query.replace(/[\\%_]/g,"\\$&")+"%");}
    if(filter.status){conditions.push("COALESCE(w.status,'new')=?");params.push(filter.status);}
    if(filter.blockId){conditions.push("s.block_id=?");params.push(filter.blockId);}
    if(filter.from){conditions.push("s.created_at>=?");params.push(filter.from);}
    if(filter.to){conditions.push("s.created_at<=?");params.push(filter.to);}
    const where=conditions.length?" WHERE "+conditions.join(" AND "):"";
    const from=" FROM submissions s LEFT JOIN submission_workflow w ON s.id=w.submission_id";
    const total=Number(this.db.prepare("SELECT COUNT(*) AS n"+from+where).get(...params)?.n??0);
    const rows=this.db.prepare("SELECT s.id,s.block_id,s.body,s.created_at,w.status,w.tags,w.note,w.assignee,w.updated_at"+from+where+" ORDER BY s.created_at DESC,s.id DESC LIMIT ? OFFSET ?").all(...params,filter.limit,filter.offset);
    const items:SubmissionEntry[]=rows.map(row=>({id:String(row.id),block_id:String(row.block_id),created_at:String(row.created_at),values:record(parsed(row.body)) as Record<string,string>,status:String(row.status??"new") as SubmissionStatus,tags:row.tags?parsed(row.tags) as string[]:[],note:String(row.note??""),assignee:String(row.assignee??""),updatedAt:String(row.updated_at??row.created_at)}));
    return {items,total,limit:filter.limit,offset:filter.offset};
  }
  updateSubmission(id:string,input:unknown):SubmissionEntry {
    const row=this.db.prepare("SELECT * FROM submissions WHERE id=?").get(id);
    if(!row)throw new HttpError(404,"SUBMISSION_NOT_FOUND","문의를 찾을 수 없습니다.");
    const v=record(input);
    const previous=this.db.prepare("SELECT * FROM submission_workflow WHERE submission_id=?").get(id);
    const status=v.status??previous?.status??"new";
    if(!["new","processing","completed","archived"].includes(String(status)))throw new HttpError(400,"SUBMISSION_STATUS","문의 상태를 확인하세요.");
    const tags=v.tags??(previous?.tags?parsed(previous.tags):[]);
    if(!Array.isArray(tags)||tags.length>20||tags.some(t=>typeof t!=="string"||t.length>60))throw new HttpError(400,"SUBMISSION_TAGS","태그는 60자 이내 최대 20개입니다.");
    const note=v.note??previous?.note??"",assignee=v.assignee??previous?.assignee??"";
    if(typeof note!=="string"||note.length>5000||typeof assignee!=="string"||assignee.length>200)throw new HttpError(400,"SUBMISSION_WORKFLOW","메모와 담당자 입력을 확인하세요.");
    if(v.action!==undefined&&!["mask","archive"].includes(String(v.action)))throw new HttpError(400,"SUBMISSION_ACTION","지원하지 않는 문의 작업입니다.");
    const now=new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if(v.action==="mask")this.db.prepare("UPDATE submissions SET body=? WHERE id=?").run(JSON.stringify(Object.fromEntries(Object.keys(record(parsed(row.body))).map(k=>[k,"[마스킹됨]"]))),id);
      this.db.prepare("INSERT INTO submission_workflow VALUES(?,?,?,?,?,?) ON CONFLICT(submission_id) DO UPDATE SET status=excluded.status,tags=excluded.tags,note=excluded.note,assignee=excluded.assignee,updated_at=excluded.updated_at").run(id,v.action==="archive"?"archived":String(status),JSON.stringify(tags),note,assignee,now);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    const updated=this.db.prepare("SELECT s.*,w.status,w.tags,w.note,w.assignee,w.updated_at FROM submissions s JOIN submission_workflow w ON s.id=w.submission_id WHERE s.id=?").get(id)!;
    return {id,block_id:String(updated.block_id),created_at:String(updated.created_at),values:record(parsed(updated.body)) as Record<string,string>,status:String(updated.status) as SubmissionStatus,tags:parsed(updated.tags) as string[],note:String(updated.note),assignee:String(updated.assignee),updatedAt:now};
  }
  backups(projectId:string):DataBackup[] {
    return this.db.prepare("SELECT * FROM data_backups WHERE project_id=? ORDER BY created_at DESC LIMIT 200").all(projectId).map(row=>({id:String(row.id),projectId,releaseId:row.release_id?String(row.release_id):null,createdAt:String(row.created_at),bytes:Number(row.bytes),reason:String(row.reason),submissions:Number(row.submissions),tables:Number(row.tables_count)}));
  }
  backupFile(projectId:string,id:string):string|null {const row=this.db.prepare("SELECT file FROM data_backups WHERE id=? AND project_id=?").get(id,projectId);return row?String(row.file):null;}
  addBackup(backup:DataBackup,file:string):void {this.db.prepare("INSERT INTO data_backups VALUES(?,?,?,?,?,?,?,?,?)").run(backup.id,backup.projectId,backup.releaseId,file,backup.bytes,backup.reason,backup.submissions,backup.tables,backup.createdAt);}
  retention(projectId:string):RetentionPolicy {const row=this.db.prepare("SELECT body FROM retention_policies WHERE project_id=?").get(projectId);return row?parsed(row.body) as RetentionPolicy:{...DEFAULT_RETENTION};}
  saveRetention(projectId:string,input:unknown):RetentionPolicy {
    const v=record(input),old=this.retention(projectId),policy={...old};
    for(const key of ["backupDays","artifactDays","auditDays","submissionDays","maxStorageMB"] as const){const n=v[key]??old[key];if(typeof n!=="number"||!Number.isInteger(n)||n<1||n>100000)throw new HttpError(400,"RETENTION","보존 기간과 용량은 1~100000의 정수여야 합니다.");policy[key]=n;}
    if(v.automaticCleanup!==undefined&&typeof v.automaticCleanup!=="boolean")throw new HttpError(400,"RETENTION","자동 정리 설정을 확인하세요.");
    policy.automaticCleanup=v.automaticCleanup===true;
    this.db.prepare("INSERT INTO retention_policies VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body").run(projectId,JSON.stringify(policy));return policy;
  }
  measure(projectId:string,operation:string,status:string,durationMs:number):void {this.db.prepare("INSERT INTO telemetry VALUES(?,?,?,?,?,?)").run(randomUUID(),projectId,operation,status,Math.max(0,Math.round(durationMs)),new Date().toISOString());}
  metrics(projectId:string):OperationMetric[] {return this.db.prepare("SELECT operation,status,COUNT(*) AS count,ROUND(AVG(duration_ms)) AS avgDurationMs,MAX(created_at) AS lastMeasuredAt FROM telemetry WHERE project_id=? GROUP BY operation,status").all(projectId).map(row=>({operation:String(row.operation),status:String(row.status),count:Number(row.count),avgDurationMs:Number(row.avgDurationMs),lastMeasuredAt:String(row.lastMeasuredAt)}));}
  siteCounts():{submissions:number;pending:number;tables:number} {return {submissions:Number(this.db.prepare("SELECT COUNT(*) AS n FROM submissions").get()?.n??0),pending:Number(this.db.prepare("SELECT COUNT(*) AS n FROM submissions s LEFT JOIN submission_workflow w ON s.id=w.submission_id WHERE COALESCE(w.status,'new') IN('new','processing')").get()?.n??0),tables:Number(this.db.prepare("SELECT COUNT(*) AS n FROM table_data").get()?.n??0)};}
}
