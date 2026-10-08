import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { ExpansionScope } from "../src/domain/expansion";
import type { WorkStatus, WorkItem } from "../src/domain/expansion";
export type { WorkStatus, WorkItem } from "../src/domain/expansion";
import { HttpError } from "./http";
import {operationContext,newOperation,bindOperation} from "./operationContext";

export const WORK_MIGRATION = `
CREATE TABLE work_items(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,kind TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,scope TEXT NOT NULL CHECK(json_valid(scope)),payload TEXT NOT NULL CHECK(json_valid(payload)),actor_id TEXT,status TEXT NOT NULL CHECK(status IN('waiting','running','succeeded','failed','cancelled','unknown')),recovery TEXT NOT NULL CHECK(recovery IN('retry','manual')),attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),next_at INTEGER NOT NULL,worker_id TEXT,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN(0,1)),result TEXT CHECK(result IS NULL OR json_valid(result)),error_code TEXT,created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,UNIQUE(organization_id,kind,request_key));
CREATE INDEX work_ready ON work_items(status,next_at,created_at);
CREATE INDEX work_organization ON work_items(organization_id,status,created_at);
CREATE TABLE work_organization_limits(organization_id TEXT PRIMARY KEY,max_running INTEGER NOT NULL CHECK(max_running BETWEEN 1 AND 16),max_waiting INTEGER NOT NULL CHECK(max_waiting BETWEEN 1 AND 1000),last_claimed_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE resource_leases(resource TEXT NOT NULL,token TEXT PRIMARY KEY,mode TEXT NOT NULL CHECK(mode IN('shared','exclusive')),owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX resource_active ON resource_leases(resource,expires_at);
CREATE TABLE studio_owner_sessions(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
`;
export interface WorkClaim extends WorkItem { leaseToken: string; leaseUntil: number; workerId: string }
export interface WorkExecution { signal: AbortSignal; assertCurrent: () => void; phase:(name:string,budgetMs?:number)=>void;traceId:string }
export interface WorkerPolicy {maxRunning:number;pools:{standard:number;cpu:number;io:number;recovery:number};maxDurationMs:number;drainMs:number}
export type WorkHandler = (item: WorkItem, execution: WorkExecution) => Promise<unknown>;
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
function scopeValue(value: ExpansionScope): string {
  for (const key of ["organizationId", "workspaceId", "projectId"] as const) if (!idPattern.test(value[key])) throw new HttpError(400, "WORK_SCOPE", "작업의 조직과 프로젝트를 확인하세요.");
  for (const key of ["siteId", "environmentId", "dataKey"] as const) if (value[key] !== undefined && !idPattern.test(value[key]!)) throw new HttpError(400, "WORK_SCOPE", "작업 환경을 확인하세요.");
  return JSON.stringify(value);
}
function work(row: Record<string, unknown>): WorkItem {
  return { id: String(row.id), kind: String(row.kind), scope: JSON.parse(String(row.scope)) as ExpansionScope, payload: JSON.parse(String(row.payload)) as unknown, actorId: row.actor_id ? String(row.actor_id) : undefined, status: String(row.status) as WorkStatus, attempts: Number(row.attempts), createdAt: Number(row.created_at), startedAt: row.started_at == null ? null : Number(row.started_at), finishedAt: row.finished_at == null ? null : Number(row.finished_at), result: row.result == null ? null : JSON.parse(String(row.result)) as unknown, errorCode: row.error_code == null ? null : String(row.error_code), cancelRequested: Boolean(row.cancel_requested) };
}
export class WorkQueue {
  private running = new Map<string, AbortController>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private readonly advanced:boolean;
  constructor(readonly db: DatabaseSync, readonly workerId: string = randomUUID(), readonly maxRunning = 2, readonly now: () => number = Date.now) {
    if (!Number.isInteger(maxRunning) || maxRunning < 1 || maxRunning > 16) throw new Error("Invalid worker concurrency");
    this.advanced=Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='system_worker_policy'").get());
    if(this.advanced){const initial:WorkerPolicy={maxRunning,pools:{standard:maxRunning,cpu:Math.min(2,maxRunning),io:maxRunning,recovery:1},maxDurationMs:600000,drainMs:5000};db.prepare("INSERT OR IGNORE INTO system_worker_policy VALUES('global',1,?,?)").run(JSON.stringify(initial),this.now());if(this.policy().maxRunning!==maxRunning)throw new HttpError(409,"WORK_POLICY_CONFLICT","동일 데이터베이스의 worker 동시 실행 설정이 다릅니다.");}
  }
  policy():WorkerPolicy{return this.advanced?JSON.parse(String(this.db.prepare("SELECT body FROM system_worker_policy WHERE id='global'").get()?.body)) as WorkerPolicy:{maxRunning:this.maxRunning,pools:{standard:this.maxRunning,cpu:this.maxRunning,io:this.maxRunning,recovery:1},maxDurationMs:600000,drainMs:5000};}
  configurePolicy(input:WorkerPolicy,baseRevision:number):{revision:number;policy:WorkerPolicy}{if(!this.advanced)throw new HttpError(409,"WORK_SCHEMA","운영 마이그레이션이 필요합니다.");if(input.maxRunning!==this.maxRunning||!Number.isInteger(input.maxDurationMs)||input.maxDurationMs<1000||input.maxDurationMs>3600000||!Number.isInteger(input.drainMs)||input.drainMs<100||input.drainMs>30000||Object.values(input.pools).some(n=>!Number.isInteger(n)||n<1||n>this.maxRunning))throw new HttpError(400,"WORK_POLICY","worker 한도와 시간 예산을 확인하세요.");const result=this.db.prepare("UPDATE system_worker_policy SET revision=revision+1,body=?,updated_at=? WHERE id='global' AND revision=?").run(JSON.stringify(input),this.now(),baseRevision);if(!result.changes)throw new HttpError(409,"WORK_POLICY_CONFLICT","다른 운영자가 worker 설정을 변경했습니다.");return {revision:baseRevision+1,policy:input};}
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  limits(organizationId: string, maxRunning: number, maxWaiting: number): void {
    if (!idPattern.test(organizationId) || !Number.isInteger(maxRunning) || maxRunning < 1 || maxRunning > 16 || !Number.isInteger(maxWaiting) || maxWaiting < 1 || maxWaiting > 1000) throw new HttpError(400, "WORK_LIMIT", "작업 한도를 확인하세요.");
    this.db.prepare("INSERT INTO work_organization_limits VALUES(?,?,?,0) ON CONFLICT(organization_id) DO UPDATE SET max_running=excluded.max_running,max_waiting=excluded.max_waiting").run(organizationId, maxRunning, maxWaiting);
  }
  enqueue(kind: string, scope: ExpansionScope, payload: unknown, key: string, actorId?: string, options: { recovery?: "retry" | "manual"; maxAttempts?: number; notBefore?: number;pool?:"standard"|"cpu"|"io"|"recovery";weight?:number;deadline?:number;traceId?:string } = {}): WorkItem {
    if (!/^[a-z][a-z0-9.-]{0,79}$/.test(kind) || !idPattern.test(key) || (actorId !== undefined && !idPattern.test(actorId))) throw new HttpError(400, "WORK_INPUT", "작업 종류와 요청 키를 확인하세요.");
    const scopeJson = scopeValue(scope), payloadJson = JSON.stringify(payload ?? null);
    if (Buffer.byteLength(payloadJson) > 1_000_000) throw new HttpError(413, "WORK_SIZE", "작업 입력이 너무 큽니다.");
    const maxAttempts = options.maxAttempts ?? 3, nextAt = options.notBefore ?? this.now();
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10 || !Number.isSafeInteger(nextAt) || nextAt < 0) throw new HttpError(400, "WORK_INPUT", "작업 재시도 설정을 확인하세요.");
    if(options.pool!==undefined&&!['standard','cpu','io','recovery'].includes(options.pool)||options.weight!==undefined&&(!Number.isInteger(options.weight)||options.weight<1||options.weight>10)||options.deadline!==undefined&&(!Number.isSafeInteger(options.deadline)||options.deadline<=this.now())||options.traceId!==undefined&&!/^[a-f0-9]{32}$/.test(options.traceId))throw new HttpError(400,"WORK_POLICY","작업 풀·가중치·마감 시간을 확인하세요.");
    const fingerprint = createHash("sha256").update(JSON.stringify([kind, scope, payload, actorId ?? null])).digest("hex");
    return this.transaction(() => {
      const repeated = this.db.prepare("SELECT * FROM work_items WHERE organization_id=? AND kind=? AND request_key=?").get(scope.organizationId, kind, key);
      if (repeated) { if (repeated.fingerprint !== fingerprint) throw new HttpError(409, "WORK_IDEMPOTENCY", "같은 작업 키의 내용이 다릅니다."); return work(repeated); }
      this.db.prepare("INSERT OR IGNORE INTO work_organization_limits VALUES(?,1,100,0)").run(scope.organizationId);
      const limit = Number(this.db.prepare("SELECT max_waiting FROM work_organization_limits WHERE organization_id=?").get(scope.organizationId)?.max_waiting);
      const waiting = Number(this.db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE organization_id=? AND status='waiting'").get(scope.organizationId)?.n);
      const total = Number(this.db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE status IN('waiting','running')").get()?.n);
      if (waiting >= limit || total >= 2000) throw new HttpError(429, "WORK_CAPACITY", "대기 작업 한도에 도달했습니다.");
      const id = randomUUID();
      this.db.prepare("INSERT INTO work_items(id,organization_id,kind,request_key,fingerprint,scope,payload,actor_id,status,recovery,max_attempts,next_at,created_at) VALUES(?,?,?,?,?,?,?,?,'waiting',?,?,?,?)").run(id, scope.organizationId, kind, key, fingerprint, scopeJson, payloadJson, actorId ?? null, options.recovery ?? "retry", maxAttempts, nextAt, this.now());
      if(this.advanced)this.db.prepare("INSERT INTO system_work_details VALUES(?,?,?,?,?,?,?,?)").run(id,options.pool??(kind==='site.generate'?'cpu':/reconcile|restore|verify/.test(kind)?'recovery':/connection|webhook|deploy/.test(kind)?'io':'standard'),options.weight??1,options.deadline??this.now()+this.policy().maxDurationMs,'waiting',this.now(),options.traceId??randomUUID().replaceAll('-',''),this.now());
      return this.get(id)!;
    });
  }
  get(id: string): WorkItem | null { const row = this.db.prepare("SELECT * FROM work_items WHERE id=?").get(id); return row ? work(row) : null; }
  list(organizationId: string, limit = 50,projectId?:string,environmentId?:string): WorkItem[] {
    if (!idPattern.test(organizationId) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "WORK_QUERY", "작업 조회 범위를 확인하세요.");
    return this.db.prepare("SELECT * FROM work_items WHERE organization_id=? AND (? IS NULL OR json_extract(scope,'$.projectId')=?) AND (? IS NULL OR json_extract(scope,'$.environmentId')=?) ORDER BY created_at DESC,id DESC LIMIT ?").all(organizationId,projectId??null,projectId??null,environmentId??null,environmentId??null, limit).map(work);
  }
  claim(leaseMs = 30_000): WorkClaim | null {
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw new Error("Invalid work lease");
    return this.transaction(() => {
      const now = this.now();
      this.db.prepare("UPDATE work_items SET status=CASE WHEN recovery='manual' THEN 'unknown' WHEN cancel_requested=1 THEN 'cancelled' WHEN attempts>=max_attempts THEN 'failed' ELSE 'waiting' END,error_code='WORK_INTERRUPTED',finished_at=CASE WHEN cancel_requested=1 OR recovery='manual' OR attempts>=max_attempts THEN ? ELSE NULL END,worker_id=NULL,lease_token=NULL,lease_until=0 WHERE status='running' AND lease_until<=?").run(now, now);
      if(this.advanced)this.db.prepare("UPDATE work_items SET status='failed',error_code='WORK_DEADLINE',finished_at=? WHERE status='waiting' AND id IN(SELECT work_id FROM system_work_details WHERE deadline<=?)").run(now,now);
      if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE status='running' AND lease_until>?").get(now)?.n) >= this.maxRunning) return null;
      const candidates=this.db.prepare("SELECT w.* FROM work_items w JOIN work_organization_limits l ON l.organization_id=w.organization_id WHERE w.status='waiting' AND w.next_at<=? AND (SELECT COUNT(*) FROM work_items r WHERE r.organization_id=w.organization_id AND r.status='running' AND r.lease_until>?)<l.max_running ORDER BY l.last_claimed_at,w.created_at,w.id LIMIT 2000").all(now,now);
      const policy=this.policy(),details=this.advanced?new Map(this.db.prepare("SELECT d.* FROM system_work_details d JOIN work_items w ON w.id=d.work_id WHERE w.status IN('running','waiting')").all().map(row=>[String(row.work_id),row])):new Map<string,Record<string,unknown>>();
      const poolCounts=new Map<string,number>();if(this.advanced)for(const row of this.db.prepare("SELECT d.pool,COUNT(*) AS n FROM work_items w JOIN system_work_details d ON d.work_id=w.id WHERE w.status='running' AND w.lease_until>? GROUP BY d.pool").all(now))poolCounts.set(String(row.pool),Number(row.n));
      const eligible=candidates.filter(row=>{const pool=String(details.get(String(row.id))?.pool??'standard') as keyof WorkerPolicy['pools'];return(poolCounts.get(pool)??0)<policy.pools[pool];});
      const waitingRecovery=eligible.some(row=>details.get(String(row.id))?.pool==='recovery');const activeCount=[...poolCounts.values()].reduce((sum,n)=>sum+n,0);
      const prioritized=waitingRecovery&&this.maxRunning>1&&activeCount>=this.maxRunning-1?eligible.filter(row=>details.get(String(row.id))?.pool==='recovery'):eligible;
      // Aging dominates weight after a bounded wait; organization claim ordering remains fair.
      const row=prioritized.sort((a,b)=>{const ageA=Math.floor((now-Number(a.created_at))/30000),ageB=Math.floor((now-Number(b.created_at))/30000);return(ageB+Number(details.get(String(b.id))?.weight??1))-(ageA+Number(details.get(String(a.id))?.weight??1));})[0];
      if (!row) return null;
      const leaseToken = randomUUID(), leaseUntil = now + leaseMs;
      this.db.prepare("UPDATE work_items SET status='running',attempts=attempts+1,worker_id=?,lease_token=?,lease_until=?,started_at=COALESCE(started_at,?) WHERE id=? AND status='waiting'").run(this.workerId, leaseToken, leaseUntil, now, String(row.id));
      this.db.prepare("UPDATE work_organization_limits SET last_claimed_at=? WHERE organization_id=?").run(now, String(row.organization_id));
      if(this.advanced)this.db.prepare("UPDATE system_work_details SET phase='claimed',phase_started_at=?,updated_at=? WHERE work_id=?").run(now,now,String(row.id));
      return { ...this.get(String(row.id))!, leaseToken, leaseUntil, workerId: this.workerId };
    });
  }
  assertCurrent(claim: WorkClaim): void {
    const row = this.db.prepare("SELECT cancel_requested FROM work_items WHERE id=? AND status='running' AND lease_token=? AND worker_id=? AND lease_until>?").get(claim.id, claim.leaseToken, claim.workerId, this.now());
    if (!row) throw new HttpError(409, "WORK_LEASE_LOST", "작업 실행 권한이 다른 worker로 넘어갔습니다.");
    if (row.cancel_requested) throw new HttpError(409, "WORK_CANCELLED", "작업을 취소했습니다.");
  }
  renew(claim: WorkClaim, leaseMs = 30_000): boolean {
    return Boolean(this.db.prepare("UPDATE work_items SET lease_until=? WHERE id=? AND status='running' AND lease_token=? AND worker_id=? AND lease_until>?").run(this.now() + leaseMs, claim.id, claim.leaseToken, claim.workerId, this.now()).changes);
  }
  complete(claim: WorkClaim, result: unknown): boolean {
    const serialized = JSON.stringify(result ?? null);
    if (Buffer.byteLength(serialized) > 2_000_000) throw new HttpError(413, "WORK_RESULT_SIZE", "작업 결과는 별도 저장소로 보관해야 합니다.");
    return Boolean(this.db.prepare("UPDATE work_items SET status='succeeded',result=?,finished_at=?,lease_token=NULL,lease_until=0,error_code=NULL WHERE id=? AND status='running' AND lease_token=? AND worker_id=? AND lease_until>?").run(serialized, this.now(), claim.id, claim.leaseToken, claim.workerId, this.now()).changes);
  }
  fail(claim: WorkClaim, error: unknown): boolean {
    const code = error instanceof HttpError ? error.code : "WORK_FAILED";
    const current = this.db.prepare("SELECT attempts,max_attempts,recovery,cancel_requested FROM work_items WHERE id=? AND status='running' AND lease_token=? AND worker_id=? AND lease_until>?").get(claim.id, claim.leaseToken, claim.workerId, this.now());
    if (!current) return false;
    const cancelled = Boolean(current.cancel_requested) || code === "WORK_CANCELLED";
    const unknown = current.recovery === "manual" || ["PROVIDER_CONNECTION", "DEPLOYMENT_VERSION", "EXTERNAL_RESULT_UNKNOWN"].includes(code);
    const retryable = !cancelled && !unknown && Number(current.attempts) < Number(current.max_attempts) && ["PROVIDER_RETRYABLE", "WORK_TEMPORARY"].includes(code);
    const status: WorkStatus = unknown ? "unknown" : cancelled ? "cancelled" : retryable ? "waiting" : "failed";
    return Boolean(this.db.prepare("UPDATE work_items SET status=?,error_code=?,next_at=?,finished_at=?,lease_token=NULL,lease_until=0 WHERE id=? AND status='running' AND lease_token=? AND worker_id=? AND lease_until>?").run(status, code, this.now() + Math.min(3600_000, 1000 * 2 ** Number(current.attempts)), retryable ? null : this.now(), claim.id, claim.leaseToken, claim.workerId, this.now()).changes);
  }
  cancel(id: string): void { this.db.prepare("UPDATE work_items SET cancel_requested=1,status=CASE WHEN status='waiting' THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status='waiting' THEN ? ELSE finished_at END WHERE id=? AND status IN('waiting','running')").run(this.now(), id); this.running.get(id)?.abort(); }
  retry(id: string, confirmedUnknown = false): WorkItem {
    this.db.exec("BEGIN IMMEDIATE");try{
    const item = this.get(id); if (!item) throw new HttpError(404, "WORK_NOT_FOUND", "작업을 찾을 수 없습니다.");
    if (!["failed", "cancelled", "unknown"].includes(item.status) || (item.status === "unknown" && !confirmedUnknown)) throw new HttpError(409, "WORK_RETRY", "실패 작업만 재시도할 수 있습니다. 결과 미확인은 공급자 상태를 확인하세요.");
    const limit=Number(this.db.prepare("SELECT max_waiting FROM work_organization_limits WHERE organization_id=?").get(item.scope.organizationId)?.max_waiting??100),waiting=Number(this.db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE organization_id=? AND status='waiting'").get(item.scope.organizationId)?.n??0);
    if(waiting>=limit)throw new HttpError(429,"WORK_WAITING_LIMIT","조직의 대기 작업 한도에 도달했습니다.");
    this.db.prepare("UPDATE work_items SET status='waiting',cancel_requested=0,attempts=0,next_at=?,finished_at=NULL,error_code=NULL WHERE id=? AND status IN('failed','cancelled','unknown')").run(this.now(), id);const result=this.get(id)!;this.db.exec("COMMIT");return result;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  async processOne(handler: WorkHandler): Promise<boolean> {
    const claim = this.claim(); if (!claim) return false;
    const controller = new AbortController(); this.running.set(claim.id, controller);
    const heartbeat = setInterval(() => { try { this.assertCurrent(claim); if (!this.renew(claim)) controller.abort(); } catch { controller.abort(); } }, 5000); heartbeat.unref();
    const detail=this.advanced?this.db.prepare("SELECT deadline,trace_id FROM system_work_details WHERE work_id=?").get(claim.id):undefined,traceId=String(detail?.trace_id??randomUUID().replaceAll('-',''));
    const duration=Math.max(1,Math.min(this.policy().maxDurationMs,Number(detail?.deadline??this.now()+this.policy().maxDurationMs)-this.now()));
    let deadline:ReturnType<typeof setTimeout>|undefined,stageTimer:ReturnType<typeof setTimeout>|undefined,stageReject:((error:HttpError)=>void)|undefined,stage:{name:string;started:number;span:string}|undefined;
    const budgets=Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE name='system_work_stage_budgets'").get());
    const jobContext=newOperation(claim.id);jobContext.traceId=traceId;
    const finishStage=(status:string):void=>{if(stageTimer)clearTimeout(stageTimer);if(!stage)return;if(budgets){this.db.prepare('UPDATE system_work_stage_budgets SET status=?,finished_at=? WHERE work_id=? AND phase=?').run(status,this.now(),claim.id,stage.name);this.db.prepare('INSERT INTO system_trace_spans VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(stage.span,traceId,jobContext.spanId,'work.'+stage.name,claim.scope.organizationId,claim.scope.projectId,claim.scope.environmentId??null,stage.started,Math.max(0,this.now()-stage.started),status==='succeeded'?'ok':'error',status==='succeeded'?null:status);}stage=undefined;};
    const aborted=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new HttpError(409,'WORK_CANCELLED','Work stopped')),{once:true});});
    const expired=new Promise<never>((_,reject)=>{deadline=setTimeout(()=>{reject(new HttpError(408,'WORK_DEADLINE','Work time budget exceeded'));controller.abort();},duration);deadline.unref();stageReject=reject;});
    const phase=(name:string,budgetMs=duration):void=>{controller.signal.throwIfAborted();this.assertCurrent(claim);if(!/^[a-zA-Z0-9._-]{1,80}$/.test(name)||!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>3600000)throw new HttpError(400,'WORK_PHASE','Invalid work phase or time budget');budgetMs=Math.min(budgetMs,duration,this.policy().maxDurationMs);finishStage('succeeded');stage={name,started:this.now(),span:randomUUID().replaceAll('-','').slice(0,16)};if(this.advanced)this.db.prepare('UPDATE system_work_details SET phase=?,phase_started_at=?,updated_at=? WHERE work_id=?').run(name,this.now(),this.now(),claim.id);if(budgets)this.db.prepare("INSERT INTO system_work_stage_budgets VALUES(?,?,?,?,'running',?,NULL) ON CONFLICT(work_id,phase) DO UPDATE SET budget_ms=excluded.budget_ms,deadline=excluded.deadline,status='running',started_at=excluded.started_at,finished_at=NULL").run(claim.id,name,budgetMs,this.now()+budgetMs,this.now());stageTimer=setTimeout(()=>{stageReject?.(new HttpError(408,'WORK_STAGE_DEADLINE','Work phase time budget exceeded'));controller.abort();},budgetMs);stageTimer.unref();};
    try { const result = await Promise.race([operationContext.run(jobContext,async()=>{bindOperation(claim.scope,claim.actorId,'system');return handler(claim, { signal: controller.signal, assertCurrent: () => { controller.signal.throwIfAborted(); this.assertCurrent(claim); },phase,traceId });}),expired,aborted]); const committed=this.complete(claim, result);finishStage(committed?'succeeded':'fenced'); }
    catch (error) { const failure=error instanceof HttpError&&['WORK_DEADLINE','WORK_STAGE_DEADLINE'].includes(error.code)?error:controller.signal.aborted ? new HttpError(409, "WORK_CANCELLED", "Work stopped") : error;this.fail(claim,failure);finishStage(failure instanceof HttpError?failure.code:'WORK_FAILED'); }
    finally { clearInterval(heartbeat);if(deadline)clearTimeout(deadline);if(stageTimer)clearTimeout(stageTimer);try{if(this.advanced){const item=this.get(claim.id);this.db.prepare('UPDATE system_work_details SET phase=?,updated_at=? WHERE work_id=?').run(item?.status??'unknown',this.now(),claim.id);if(budgets)this.db.prepare('INSERT INTO system_trace_spans VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(jobContext.spanId,traceId,null,'work.execute',claim.scope.organizationId,claim.scope.projectId,claim.scope.environmentId??null,claim.startedAt??this.now(),Math.max(0,this.now()-(claim.startedAt??this.now())),item?.status==='succeeded'?'ok':'error',item?.errorCode??null);}}finally{this.running.delete(claim.id);} }
    return true;
  }
  start(handler: WorkHandler): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { if (this.stopped) return; while (this.running.size < this.maxRunning) { const before = this.running.size; const pending = this.processOne(handler); void pending.catch((error: unknown) => { console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service: "automade-worker", operation: "work.claim", errorCode: error instanceof HttpError ? error.code : "WORK_STORE_ERROR" })); }); if (this.running.size === before || this.running.size >= this.maxRunning) break; } }, 250); this.timer.unref();
  }
  async close(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); for (const controller of this.running.values()) controller.abort();const until=Date.now()+this.policy().drainMs;while (this.running.size&&Date.now()<until) await new Promise<void>(resolve => setTimeout(resolve, 20));if(this.running.size)throw new HttpError(503,'WORK_DRAIN_TIMEOUT','중단되지 않은 worker가 있습니다.'); }
  metrics(organizationId: string,projectId?:string,environmentId?:string): { status: string; count: number; averageQueueMs: number; averageRunMs: number }[] {
    return this.db.prepare("SELECT status,COUNT(*) AS n,COALESCE(AVG(MAX(0,COALESCE(started_at,?)-created_at)),0) AS queued,COALESCE(AVG(MAX(0,COALESCE(finished_at,?)-COALESCE(started_at,?))),0) AS runtime FROM work_items WHERE organization_id=? AND (? IS NULL OR json_extract(scope,'$.projectId')=?) AND (? IS NULL OR json_extract(scope,'$.environmentId')=?) GROUP BY status").all(this.now(), this.now(), this.now(), organizationId,projectId??null,projectId??null,environmentId??null,environmentId??null).map(row => ({ status: String(row.status), count: Number(row.n), averageQueueMs: Math.round(Number(row.queued)), averageRunMs: Math.round(Number(row.runtime)) }));
  }
}

export class ResourceLeases {
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) {}
  acquire(resource: string, owner: string, mode: "shared" | "exclusive" = "exclusive", ttlMs = 30_000): { token: string; assertCurrent: () => void; renew: () => boolean; release: () => void } {
    if (!/^[a-zA-Z0-9_:.-]{1,240}$/.test(resource) || !idPattern.test(owner) || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000) throw new HttpError(400, "LEASE_INPUT", "작업 보호 범위를 확인하세요.");
    const token = randomUUID(); this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM resource_leases WHERE expires_at<=?").run(this.now());
      const conflict = this.db.prepare("SELECT token FROM resource_leases WHERE resource=? AND expires_at>? AND (?='exclusive' OR mode='exclusive') LIMIT 1").get(resource, this.now(), mode);
      if (conflict) throw new HttpError(409, "RESOURCE_BUSY", "해당 자료를 다른 작업에서 사용 중입니다.");
      this.db.prepare("INSERT INTO resource_leases VALUES(?,?,?,?,?)").run(resource, token, mode, owner, this.now() + ttlMs); this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { token, assertCurrent: () => { if (!this.db.prepare("SELECT token FROM resource_leases WHERE token=? AND owner=? AND expires_at>?").get(token, owner, this.now())) throw new HttpError(409, "LEASE_LOST", "자료 사용 권한이 만료되었습니다."); }, renew: () => Boolean(this.db.prepare("UPDATE resource_leases SET expires_at=? WHERE token=? AND owner=? AND expires_at>?").run(this.now() + ttlMs, token, owner, this.now()).changes), release: () => { this.db.prepare("DELETE FROM resource_leases WHERE token=? AND owner=?").run(token, owner); } };
  }
  active(resource: string): boolean { return Boolean(this.db.prepare("SELECT token FROM resource_leases WHERE resource=? AND expires_at>? LIMIT 1").get(resource, this.now())); }
  resources(prefix: string): string[] { return this.db.prepare("SELECT DISTINCT resource FROM resource_leases WHERE resource LIKE ? ESCAPE '!' AND expires_at>?").all(prefix.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_") + "%", this.now()).map(row => String(row.resource)); }
}
