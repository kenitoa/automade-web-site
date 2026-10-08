import type { DatabaseSync } from "node:sqlite";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request } from "node:https";
import { randomUUID } from "node:crypto";
import { publicAddress } from "../generationAdapter";
import { HttpError } from "../http";
import { record } from "../../src/domain/validation";
import { audit, boolean, hash, many, now, one, text, transaction, type SqlRow } from "./common";
import { recordPlatformEvent } from "./events";
import { boundedProviderRequest } from "../advancement/adapters";
import { assertRuntimeFeature } from "../advancement/config";
import { operationContext } from "../operationContext";
export interface Connection { id: string; projectId: string; kind: string; endpoint: string; allowedHost: string; secretRef: string; webhookSecretRef: string; paused: boolean; mapping: Record<string, string>; db?:DatabaseSync;requestTimeoutMs?:number; resolveSecret?: (reference: string) => string | undefined; }
const scopedResolvers = new WeakMap<DatabaseSync, { resolve: (reference: string) => string | undefined; managed: boolean }>();
export function setConnectionSecretResolver(db: DatabaseSync, resolve: (reference: string) => string | undefined, managed = true): void { scopedResolvers.set(db, { resolve, managed }); }
export function connectionSecret(connection: Connection, reference: string): string | undefined { return connection.resolveSecret ? connection.resolveSecret(reference) : process.env[reference]; }
function secretFor(db: DatabaseSync, reference: string): string | undefined { const resolver = scopedResolvers.get(db); return resolver ? resolver.resolve(reference) ?? (resolver.managed ? undefined : process.env[reference]) : process.env[reference]; }
export function configuredHosts(): string[] { return (process.env.PLATFORM_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean); }
export function validateEndpoint(endpoint: string, allowedHost: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new HttpError(400, "ENDPOINT", "연결 주소를 확인하세요."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || url.hostname !== allowedHost || !configuredHosts().includes(url.hostname) || [...url.searchParams.keys()].some((key) => /(?:token|secret|password|api.?key|authorization)/i.test(key))) throw new HttpError(400, "ENDPOINT", "비밀값이 없는, 환경 변수의 허용 호스트와 일치하는 HTTPS 주소가 필요합니다.");
  return url;
}
function reference(value: unknown): string {
  const result = text(value ?? "", "비밀 환경 변수 이름", 80, true);
  if (result && !/^[A-Z][A-Z0-9_]{1,79}$/.test(result)) throw new HttpError(400, "SECRET_REF", "비밀값 대신 서버 환경 변수 이름을 입력하세요.");
  if (/^(?:AUTH_|STUDIO_|EXPANSION_|DEPLOYMENT_|DATABASE_|PLATFORM_ADMIN_|AI_)/.test(result)) throw new HttpError(403, "SECRET_REF_RESERVED", "플랫폼 관리·배포·AI 자격 증명을 사이트 공급자 연결에 사용할 수 없습니다.");
  return result;
}
export function saveConnection(db: DatabaseSync, project: string, value: Record<string, unknown>): SqlRow {
  const id = value.id ? text(value.id, "연결 ID", 100) : randomUUID();
  const existing = one(db, "SELECT project_id FROM platform_connections WHERE id=?", id);
  if (existing && existing.project_id !== project) throw new HttpError(403, "OWNERSHIP", "다른 사이트의 연결입니다.");
  const kind = text(value.kind, "연결 종류", 20);
  if (!["mail", "crm", "data", "payment"].includes(kind)) throw new HttpError(400, "KIND", "연결 종류를 확인하세요.");
  const endpoint = text(value.endpoint, "HTTPS 주소", 2000), host = text(value.allowedHost, "허용 호스트", 254).toLowerCase();
  validateEndpoint(endpoint, host);
  const mapping = record(value.mapping ?? {});
  if (Object.keys(mapping).length > 50 || Object.entries(mapping).some(([key, path]) => !/^[a-zA-Z0-9_-]{1,80}$/.test(key) || typeof path !== "string" || !/^[a-zA-Z0-9_.-]{1,200}$/.test(path) || path.split(".").some((part) => ["__proto__", "constructor", "prototype"].includes(part)))) throw new HttpError(400, "MAPPING", "데이터 필드 매핑을 확인하세요.");
  const secretRef = reference(value.secretRef), webhookSecretRef = reference(value.webhookSecretRef);
  if ((scopedResolvers.get(db)?.managed || process.env.APP_MODE === "managed") && [secretRef, webhookSecretRef].some(ref => ref && (!/^TENANT_[A-Z0-9_]{1,72}$/.test(ref) || !secretFor(db, ref)))) throw new HttpError(403, "SECRET_SCOPE", "현재 조직·작업공간의 활성 비밀 참조만 연결할 수 있습니다.");
  if (["mail", "crm", "payment"].includes(kind) && !secretRef) throw new HttpError(400, "PROVIDER_CONFIG", "업무 연결의 API 비밀 환경 변수 이름이 필요합니다.");
  if (kind === "payment" && (!secretRef || !webhookSecretRef)) throw new HttpError(400, "PAYMENT_CONFIG", "결제 API와 웹훅 비밀 환경 변수 이름이 필요합니다.");
  const paused = boolean(value.paused, "일시 중지", false) ? 1 : 0;
  db.prepare("INSERT INTO platform_connections VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,endpoint=excluded.endpoint,allowed_host=excluded.allowed_host,secret_ref=excluded.secret_ref,webhook_secret_ref=excluded.webhook_secret_ref,mapping=excluded.mapping,paused=excluded.paused").run(id, project, text(value.name, "연결 이름", 100), kind, endpoint, host, secretRef, webhookSecretRef, JSON.stringify(mapping), paused, "untested");
  audit(db, "connection.save", id);
  return connectionInfo(db, project).find((row) => row.id === id)!;
}
export function connectionInfo(db: DatabaseSync, project: string): SqlRow[] {
  return many(db, "SELECT id,name,kind,endpoint,allowed_host AS allowedHost,secret_ref AS secretRef,webhook_secret_ref AS webhookSecretRef,paused,last_status AS lastStatus,last_at AS lastAt FROM platform_connections WHERE project_id=?", project).map((row) => ({ ...row, configured: (!row.secretRef || Boolean(secretFor(db, String(row.secretRef)))) && (row.kind !== "payment" || Boolean(secretFor(db, String(row.webhookSecretRef)))), paused: Boolean(row.paused) }));
}
export function getConnection(db: DatabaseSync, id: string): Connection {
  const row = one(db, "SELECT * FROM platform_connections WHERE id=?", id);
  if (!row) throw new HttpError(404, "CONNECTION", "연결 설정이 없습니다.");
  return { db,id: String(row.id), projectId: String(row.project_id), kind: String(row.kind), endpoint: String(row.endpoint), allowedHost: String(row.allowed_host), secretRef: String(row.secret_ref), webhookSecretRef: String(row.webhook_secret_ref), paused: Boolean(row.paused), mapping: JSON.parse(String(row.mapping)) as Record<string, string>, ...(scopedResolvers.has(db) ? { resolveSecret: (reference: string) => secretFor(db, reference) } : {}) };
}
export type Transport = (connection: Connection, method: "GET" | "POST", payload?: unknown, idempotencyKey?: string) => Promise<unknown>;
export const providerRequest: Transport = (connection,method,payload,idempotencyKey=randomUUID())=>connection.db?boundedProviderRequest(connection.db,connection,method,payload,idempotencyKey,rawProviderRequest):rawProviderRequest(connection,method,payload,idempotencyKey);
const rawProviderRequest: Transport = async (connection, method, payload, idempotencyKey = randomUUID()) => {
  if (connection.paused) throw new HttpError(409, "CONNECTION_PAUSED", "연결이 일시 중지되어 있습니다.");
  const url = validateEndpoint(connection.endpoint, connection.allowedHost);
  const secret = connection.secretRef ? connectionSecret(connection, connection.secretRef) : undefined;
  if (connection.secretRef && !secret) throw new HttpError(503, "PROVIDER_UNCONFIGURED", "서버에 연결 비밀 환경 변수를 설정하세요.");
  const started = Date.now();
  const deadlineMs=Math.min(10000,connection.requestTimeoutMs??10000);
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HttpError(504, "PROVIDER_DEADLINE", "공급자 DNS 조회 제한 시간을 초과했습니다.")), deadlineMs);
    lookup(url.hostname, { all: true }).then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(new HttpError(502, "PROVIDER_DNS", "공급자 주소를 확인할 수 없습니다.")); });
  });
  if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address))) throw new HttpError(400, "PROVIDER_ADDRESS", "공개 네트워크 주소만 허용합니다.");
  const serialized = method === "POST" ? JSON.stringify(payload ?? {}) : undefined;
  if (serialized && Buffer.byteLength(serialized) > 1_000_000) throw new HttpError(413, "PROVIDER_PAYLOAD_LIMIT", "공급자 요청 본문 크기를 확인하세요.");
  if (Date.now() - started >= deadlineMs) throw new HttpError(504, "PROVIDER_DEADLINE", "공급자 연결 제한 시간을 초과했습니다.");
  return await new Promise((resolve, reject) => {
    const context=operationContext.getStore(),trace=context&&/^[a-f0-9]{32}$/.test(context.traceId)&&/^[a-f0-9]{16}$/.test(context.spanId)?`00-${context.traceId}-${context.spanId}-01`:undefined;
    const req = request(url, { method, headers: { Accept: "application/json", "X-Request-ID": context?.requestId??idempotencyKey, "Idempotency-Key": idempotencyKey,...(trace?{traceparent:trace}:{}), ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(serialized ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(serialized) } : {}) }, lookup: (_hostname, options, callback) => { if (options.all) callback(null, addresses); else callback(null, addresses[0]!.address, addresses[0]!.family); } }, (res) => {
      let size = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1_000_000) req.destroy(new Error("RESPONSE_LIMIT")); else chunks.push(chunk); });
      res.once("error", () => reject(new HttpError(502, "PROVIDER_CONNECTION", "외부 서비스 응답을 받지 못했습니다.")));
      res.once("end", () => {
        const status = res.statusCode ?? 500;
        if (status < 200 || status >= 300) {const error=new HttpError(status===429||status>=500?503:502,status===429||status>=500?"PROVIDER_RETRYABLE":"PROVIDER_REJECTED","외부 서비스가 요청을 처리하지 못했습니다."),retry=res.headers['retry-after'];if(typeof retry==='string'){const seconds=Number(retry),delay=Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-Date.now();Object.assign(error,{retryAfterMs:Math.max(0,Math.min(60000,delay||0))});}reject(error);return;}
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown); } catch { reject(new HttpError(502, "PROVIDER_SCHEMA", "외부 서비스 응답 형식을 확인하세요.")); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("DEADLINE")), Math.max(1, deadlineMs - (Date.now() - started)));
    req.once("close", () => clearTimeout(deadline));
    req.once("error", () => reject(new HttpError(502, "PROVIDER_CONNECTION", "외부 서비스 연결이 실패하거나 제한 시간을 초과했습니다.")));
    req.end(serialized);
  });
};
export async function testConnection(db: DatabaseSync, id: string, transport: Transport = providerRequest): Promise<SqlRow> {
  const connection = getConnection(db, id);
  try { await transport(connection, "GET"); db.prepare("UPDATE platform_connections SET last_status='reachable',last_at=? WHERE id=?").run(now(), id); audit(db, "connection.test", id); return { status: "reachable", message: "연결 응답을 확인했습니다. 실제 업무 처리·메일 전달·결제는 별도 검증이 필요합니다." }; }
  catch (error) { const code = error instanceof HttpError ? error.code : "PROVIDER_CONNECTION"; db.prepare("UPDATE platform_connections SET last_status=?,last_at=? WHERE id=?").run(code, now(), id); audit(db, "connection.test", id, "failed"); throw error; }
}
export function enqueue(db: DatabaseSync, project: string, connectionId: string, eventKey: string, payload: unknown): string {
  if(!payload||typeof payload!=='object'||!['account.password_reset','creator.password_reset'].includes(String((payload as Record<string,unknown>).type)))assertRuntimeFeature(db,'external-writes');
  const connection = getConnection(db, connectionId);
  if (connection.projectId !== project || !["mail", "crm"].includes(connection.kind)) throw new HttpError(400, "CONNECTION", "이 사이트의 메일 또는 CRM 연결이 필요합니다.");
  const serialized = JSON.stringify(payload), existing = one(db, "SELECT id,body FROM platform_outbox WHERE connection_id=? AND event_key=?", connectionId, eventKey);
  if (existing) { if (String(existing.body) !== serialized) throw new HttpError(409, "IDEMPOTENCY", "같은 이벤트 키의 내용이 다릅니다."); return String(existing.id); }
  const id = randomUUID();
  db.prepare("INSERT INTO platform_outbox(id,project_id,connection_id,event_key,body,status,attempts,next_at,created_at) VALUES(?,?,?,?,?,'pending',0,?,?)").run(id, project, connectionId, eventKey, serialized, Date.now(), now());
  audit(db, "outbox.enqueue", id);
  return id;
}
export function enqueueSubmission(db: DatabaseSync, project: string, submission: { id: string; blockId: string; values: Record<string, string> }): void {
  recordPlatformEvent(db, project, "form.submitted", submission.id, { id: submission.id, submissionId: submission.id, blockId: submission.blockId, values: submission.values });
  for (const row of many(db, "SELECT id FROM platform_connections WHERE project_id=? AND kind IN('mail','crm')", project)) enqueue(db, project, String(row.id), `submission:${submission.id}`, { type: "form.submitted", submission });
}
function resetMessageError(db: DatabaseSync, payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !["account.password_reset", "creator.password_reset"].includes(String((payload as Record<string, unknown>).type))) return null;
  const token = (payload as Record<string, unknown>).token;
  if (typeof token !== "string") return "RESET_TOKEN_REMOVED";
  const table = (payload as Record<string, unknown>).type === "creator.password_reset" ? "creator_reset_tokens" : "platform_reset_tokens";
  const reset = one(db, `SELECT expires_at,used_at FROM ${table} WHERE token_hash=?`, hash(token));
  return !reset || reset.used_at !== null || Number(reset.expires_at) <= Date.now() ? "RESET_TOKEN_EXPIRED" : null;
}
function scrubResetMessage(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !["account.password_reset", "creator.password_reset"].includes(String((payload as Record<string, unknown>).type))) return payload;
  const result: Record<string, unknown> = { ...(payload as Record<string, unknown>), tokenRemoved: true }; delete result.token; return result;
}
export function retryOutbox(db: DatabaseSync, project: string, id: string): void {
  const current = one(db, "SELECT body,status,error_code FROM platform_outbox WHERE id=? AND project_id=?", id, project);
  if (!current) throw new HttpError(404, "OUTBOX", "발송 항목을 찾을 수 없습니다.");
  if (current.status !== "failed") throw new HttpError(409, "OUTBOX_STATUS", "실패한 발송 항목만 재시도할 수 있습니다.");
  if(current.error_code==='EXTERNAL_RESULT_UNKNOWN')throw new HttpError(409,'UNKNOWN_EVIDENCE_REQUIRED','제공자 상태가 확인되지 않은 전달은 새로 전송할 수 없습니다. 상태 조회와 대사 근거가 필요합니다.');
  const code = resetMessageError(db, JSON.parse(String(current.body)) as unknown);
  if (code) throw new HttpError(409, code, "만료되었거나 제거된 비밀번호 복구 안내입니다. 새 복구 요청을 만드세요.");
  db.prepare("UPDATE platform_outbox SET status='pending',attempts=0,next_at=?,error_code=NULL WHERE id=? AND project_id=? AND status='failed'").run(Date.now(), id, project); audit(db, "outbox.retry", id);
}
export async function processOutbox(db: DatabaseSync, transport: Transport = providerRequest): Promise<number> {
  transaction(db, () => {
    // Expired messages are scrubbed even when their provider is paused.
    for (const row of many(db, "SELECT id,body,status FROM platform_outbox WHERE json_extract(body,'$.type') IN('account.password_reset','creator.password_reset') AND json_type(body,'$.token')='text' LIMIT 1000")) {
      const payload: unknown = JSON.parse(String(row.body)), code = resetMessageError(db, payload);
      if (code || ["sent", "failed"].includes(String(row.status))) db.prepare("UPDATE platform_outbox SET body=?,status=?,error_code=?,lease_until=0 WHERE id=?").run(JSON.stringify(scrubResetMessage(payload)), row.status === "sent" ? "sent" : "failed", row.status === "sent" ? null : code ?? "RESET_TOKEN_REMOVED", String(row.id));
    }
  });
  let processed = 0;
  for (let index = 0; index < 10; index++) {
    const row = transaction(db, () => {
      for(const expired of many(db,"SELECT id,connection_id FROM platform_outbox WHERE status='sending' AND lease_until<? LIMIT 100",Date.now())){const policy=one(db,"SELECT capabilities FROM advancement_adapter_policy WHERE connection_id=?",String(expired.connection_id)),safe=policy&&JSON.parse(String(policy.capabilities)).idempotentWrites===true;db.prepare("UPDATE platform_outbox SET status=?,error_code=?,lease_until=0 WHERE id=? AND status='sending' AND lease_until<?").run(safe?'pending':'failed',safe?null:'EXTERNAL_RESULT_UNKNOWN',String(expired.id),Date.now());}
      const candidate = one(db, "SELECT o.* FROM platform_outbox o JOIN platform_connections c ON c.id=o.connection_id WHERE o.status='pending' AND o.next_at<=? AND c.paused=0 ORDER BY o.created_at LIMIT 1", Date.now());
      if (!candidate) return null;
      const lease = Math.max(Date.now() + 30_000, Number(candidate.lease_until) + 1);
      db.prepare("UPDATE platform_outbox SET status='sending',attempts=attempts+1,lease_until=? WHERE id=? AND status='pending'").run(lease, String(candidate.id));
      const claimed: SqlRow = { ...candidate, lease_until: lease };
      return claimed;
    });
    if (!row) break;
    processed++;
    const id = String(row.id);
    const payload: unknown = JSON.parse(String(row.body));
    try {
      const expired = resetMessageError(db, payload); if (expired) throw new HttpError(409, expired, "복구 안내가 만료되었습니다.");
      if(!payload||typeof payload!=='object'||!['account.password_reset','creator.password_reset'].includes(String((payload as Record<string,unknown>).type)))assertRuntimeFeature(db,'external-writes');
      const connection = getConnection(db, String(row.connection_id));
      if (connection.paused) {
        const updated = db.prepare("UPDATE platform_outbox SET status='pending',attempts=?,lease_until=0 WHERE id=? AND status='sending' AND lease_until=?").run(Number(row.attempts), id, Number(row.lease_until));
        if (Number(updated.changes)) audit(db, "outbox.send", id, "paused");
        continue;
      }
      await transport(connection, "POST", { eventId: id, eventKey: row.event_key, payload }, id);
      const updated = db.prepare("UPDATE platform_outbox SET status='sent',body=?,lease_until=0,error_code=NULL WHERE id=? AND status='sending' AND lease_until=?").run(JSON.stringify(scrubResetMessage(payload)), id, Number(row.lease_until));
      if (Number(updated.changes)) audit(db, "outbox.send", id);
    } catch (error) {
      const attempts = Number(row.attempts) + 1, reported = error instanceof HttpError ? error.code : "PROVIDER_CONNECTION",policy=one(db,'SELECT capabilities FROM advancement_adapter_policy WHERE connection_id=?',String(row.connection_id)),idempotent=Boolean(policy&&JSON.parse(String(policy.capabilities)).idempotentWrites===true),unknown=!idempotent&&['PROVIDER_RETRYABLE','PROVIDER_CONNECTION','PROVIDER_DEADLINE'].includes(reported),code=unknown?'EXTERNAL_RESULT_UNKNOWN':reported;
      if(['FEATURE_PAUSED','ORGANIZATION_ARCHIVED'].includes(code)){db.prepare("UPDATE platform_outbox SET status='pending',attempts=?,next_at=?,lease_until=0,error_code=? WHERE id=? AND status='sending' AND lease_until=?").run(Number(row.attempts),Date.now()+1000,code,id,Number(row.lease_until));continue;}
      const retry = attempts < 5 && ["PROVIDER_RETRYABLE", "PROVIDER_CONNECTION", "PROVIDER_DNS", "PROVIDER_DEADLINE"].includes(code);
      const updated = db.prepare("UPDATE platform_outbox SET status=?,body=?,next_at=?,lease_until=0,error_code=? WHERE id=? AND status='sending' AND lease_until=?").run(retry ? "pending" : "failed", JSON.stringify(retry ? payload : scrubResetMessage(payload)), Date.now() + Math.min(3600_000, 1000 * 2 ** attempts), code, id, Number(row.lease_until));
      if (Number(updated.changes)) audit(db, "outbox.send", id, "failed");
    }
  }
  return processed;
}
export function outboxInfo(db: DatabaseSync, project: string): SqlRow[] { return many(db, "SELECT id,connection_id AS connectionId,event_key AS eventKey,status,attempts,next_at AS nextAt,error_code AS errorCode,created_at AS createdAt FROM platform_outbox WHERE project_id=? ORDER BY created_at DESC LIMIT 100", project); }
export async function externalData(db: DatabaseSync, id: string, refresh = false, transport: Transport = providerRequest): Promise<SqlRow> {
  const connection = getConnection(db, id);
  if (connection.kind !== "data") throw new HttpError(400, "CONNECTION_KIND", "데이터 연결을 선택하세요.");
  const cache = one(db, "SELECT * FROM platform_data_cache WHERE connection_id=?", id);
  if (!refresh && cache && Number(cache.expires_at) > Date.now()) return { rows: JSON.parse(String(cache.body)) as unknown, fetchedAt: cache.fetched_at, cached: true };
  const response = await transport(connection, "GET");
  const candidate = Array.isArray(response) ? response : record(response).data;
  if (!Array.isArray(candidate) || candidate.length > 1000) throw new HttpError(502, "DATA_SCHEMA", "데이터 API는 최대 1000행 배열 또는 data 배열을 반환해야 합니다.");
  const rows = candidate.map((item: unknown) => {
    const input = record(item); const mapped: Record<string, string | number | boolean | null> = {};
    for (const [key, path] of Object.entries(connection.mapping)) {
      let current: unknown = input;
      for (const part of path.split(".")) current = current && typeof current === "object" && Object.hasOwn(current, part) ? (current as Record<string, unknown>)[part] : null;
      if (current !== null && !["string", "number", "boolean"].includes(typeof current)) throw new HttpError(502, "DATA_MAPPING", "매핑 결과는 문자열·숫자·참/거짓이어야 합니다.");
      if (typeof current === "string" && current.length > 5000) throw new HttpError(502, "DATA_MAPPING", "매핑된 값이 너무 깁니다.");
      mapped[key] = current as string | number | boolean | null;
    }
    return mapped;
  });
  const fetchedAt = now();
  db.prepare("INSERT INTO platform_data_cache VALUES(?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at,fetched_at=excluded.fetched_at").run(id, JSON.stringify(rows), Date.now() + 300_000, fetchedAt);
  audit(db, "data.fetch", id); return { rows, fetchedAt, cached: false, fingerprint: hash(JSON.stringify(rows)) };
}
export function startPlatformWorker(db: DatabaseSync, shouldRun: () => boolean = () => true): () => Promise<void> {
  let running: Promise<number> | null = null, stopped = false;
  const timer = setInterval(() => { if (stopped || running || !shouldRun()) return; running = processOutbox(db).catch((error: unknown) => { console.error(JSON.stringify({ operation: "outbox.worker", errorCode: error instanceof HttpError ? error.code : "INTERNAL_ERROR" })); return 0; }).finally(() => { running = null; }); }, 5000);
  timer.unref();
  return async () => { stopped = true; clearInterval(timer); if (running) await running; };
}
