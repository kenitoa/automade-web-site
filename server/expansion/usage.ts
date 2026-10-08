import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ExpansionScope,
  UsageReservation,
} from "../../src/domain/expansion";
import { HttpError } from "../http";
import { operationContext } from "../operationContext";
import { fingerprint as digest } from "../advancement/common";
import {
  hash,
  integer,
  many,
  now,
  one,
  period,
  text,
  transaction,
  type SqlRow,
} from "../platform/common";
export class UsageService {
  constructor(readonly db: DatabaseSync) {}
  private dto(row: SqlRow): UsageReservation {
    return {
      id: String(row.id),
      scope: {
        organizationId: String(row.organization_id),
        workspaceId: String(row.workspace_id),
        projectId: String(row.project_id),
        ...(row.environment_id?{environmentId:String(row.environment_id)}:{}),
        ...(row.data_key?{dataKey:String(row.data_key)}:{}),
      },
      metric: String(row.metric),
      amount: Number(row.amount),
      committedAmount: Number(row.committed_amount),
      key: String(row.request_key),
      status: String(row.status) as UsageReservation["status"],
      expiresAt: new Date(Number(row.expires_at)).toISOString(),
      createdAt: String(row.created_at),
    };
  }
  private expire(): void {
    this.db.prepare("UPDATE expansion_usage_reservations SET status='committed',committed_amount=(SELECT SUM(e.amount) FROM advancement_usage_entries e WHERE e.reservation_id=expansion_usage_reservations.id) WHERE status IN('reserved','expired') AND EXISTS(SELECT 1 FROM advancement_usage_entries e WHERE e.reservation_id=expansion_usage_reservations.id)").run();
    this.db
      .prepare(
        "UPDATE expansion_usage_reservations SET status='expired' WHERE status='reserved' AND expires_at<=?",
      )
      .run(Date.now());
  }
  list(scope: ExpansionScope): UsageReservation[] {
    this.expire();
    return many(
      this.db,
      "SELECT * FROM expansion_usage_reservations WHERE organization_id=? AND project_id=? AND COALESCE(environment_id,'')=? ORDER BY created_at DESC LIMIT 200",
      scope.organizationId,
      scope.projectId,
      scope.environmentId??'',
    ).map((row) => this.dto(row));
  }
  budget(organizationId: string): SqlRow[] {
    this.expire();
    return many(
      this.db,
      "SELECT l.metric,l.period,l.amount AS limitAmount,COALESCE(SUM(CASE WHEN r.status='reserved' THEN r.amount WHEN r.status='committed' THEN r.committed_amount ELSE 0 END),0) AS used FROM expansion_usage_limits l LEFT JOIN expansion_usage_reservations r ON r.organization_id=l.organization_id AND r.metric=l.metric AND r.period=l.period WHERE l.organization_id=? GROUP BY l.metric,l.period ORDER BY l.period DESC,l.metric LIMIT 200",
      organizationId,
    ).map((row) => {
      if (row.metric !== "ai.requests") return row;
      const counter = one(
        this.db,
        "SELECT value FROM runtime_state WHERE key=?",
        `aiUsageOrg:${organizationId}:${String(row.period)}`,
      );
      if (!counter) return row;
      const value: unknown = JSON.parse(String(counter.value)),
        used =
          value && typeof value === "object"
            ? (value as Record<string, unknown>).used
            : undefined;
      if (
        typeof used !== "number" ||
        !Number.isSafeInteger(used) ||
        used < 0 ||
        !Number.isSafeInteger(used + Number(row.used))
      )
        throw new HttpError(
          503,
          "ORG_USAGE_STATE",
          "조직 AI 사용량 원장을 확인하세요.",
        );
      return { ...row, used: used + Number(row.used) };
    });
  }
  limit(organizationId: string, input: Record<string, unknown>): void {
    const metric = this.metric(input.metric),
      month =
        input.period === undefined
          ? period()
          : text(input.period, "사용 기간", 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      throw new HttpError(
        400,
        "USAGE_PERIOD",
        "월 단위 사용 기간을 확인하세요.",
      );
    this.db
      .prepare(
        "INSERT INTO expansion_usage_limits VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET amount=excluded.amount",
      )
      .run(
        organizationId,
        metric,
        month,
        integer(input.amount, "한도", 0, Number.MAX_SAFE_INTEGER),
      );
  }
  private metric(value: unknown): string {
    const result = text(value, "사용량 종류", 100);
    if (!/^[a-z][a-zA-Z0-9_.-]*$/.test(result))
      throw new HttpError(400, "USAGE_METRIC", "사용량 종류를 확인하세요.");
    return result;
  }
  reserve(
    scope: ExpansionScope,
    metricInput: unknown,
    amountInput: unknown,
    keyInput: unknown,
    ttlMs = 3600_000,
  ): UsageReservation {
    const metric = this.metric(metricInput),
      amount = integer(amountInput, "예약 사용량", 1, Number.MAX_SAFE_INTEGER),
      key = text(keyInput, "사용량 예약 키", 100),
      month = period(),
      fingerprint = hash(JSON.stringify([scope, metric, amount, ttlMs]));
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 86400_000)
      throw new HttpError(400, "USAGE_EXPIRY", "예약 만료 시간을 확인하세요.");
    return transaction(this.db, () => {
      this.expire();
      const old = one(
        this.db,
        "SELECT * FROM expansion_usage_reservations WHERE organization_id=? AND metric=? AND period=? AND request_key=?",
        scope.organizationId,
        metric,
        month,
        key,
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "USAGE_IDEMPOTENCY",
            "동일 예약 키의 범위 또는 사용량이 다릅니다.",
          );
        return this.dto(old);
      }
      const limit = one(
        this.db,
        "SELECT amount FROM expansion_usage_limits WHERE organization_id=? AND metric=? AND period=?",
        scope.organizationId,
        metric,
        month,
      );
      const used = Number(
        one(
          this.db,
          "SELECT COALESCE(SUM(CASE WHEN status='reserved' THEN amount WHEN status='committed' THEN committed_amount ELSE 0 END),0) AS used FROM expansion_usage_reservations WHERE organization_id=? AND metric=? AND period=?",
          scope.organizationId,
          metric,
          month,
        )?.used ?? 0,
      );
      if (
        !Number.isSafeInteger(used + amount) ||
        (limit && used + amount > Number(limit.amount))
      )
        throw new HttpError(
          429,
          "ORG_USAGE_LIMIT",
          "조직 사용량 한도를 초과합니다.",
        );
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO expansion_usage_reservations(id,organization_id,workspace_id,project_id,metric,period,amount,committed_amount,request_key,fingerprint,status,expires_at,created_at,environment_id,data_key,operation_id) VALUES(?,?,?,?,?,?,?,0,?,?,'reserved',?,?,?,?,?)",
        )
        .run(
          id,
          scope.organizationId,
          scope.workspaceId,
          scope.projectId,
          metric,
          month,
          amount,
          key,
          fingerprint,
          Date.now() + ttlMs,
          now(),
          scope.environmentId??null,
          scope.dataKey??scope.projectId,
          operationContext.getStore()?.operationId??null,
        );
      return this.dto(
        one(
          this.db,
          "SELECT * FROM expansion_usage_reservations WHERE id=?",
          id,
        )!,
      );
    });
  }
  settle(
    scope: ExpansionScope,
    id: string,
    amountInput: unknown,
    release = false,
  ): UsageReservation {
    const amount = release
      ? 0
      : integer(amountInput, "확정 사용량", 0, Number.MAX_SAFE_INTEGER);
    return transaction(this.db, () => {
      this.expire();
      const row = one(
        this.db,
        "SELECT * FROM expansion_usage_reservations WHERE id=? AND organization_id=? AND project_id=? AND COALESCE(environment_id,'')=?",
        id,
        scope.organizationId,
        scope.projectId,
        scope.environmentId??'',
      );
      if (!row)
        throw new HttpError(
          404,
          "USAGE_RESERVATION",
          "사용량 예약을 찾을 수 없습니다.",
        );
      if (row.status !== "reserved") {
        if (
          (release && row.status === "released") ||
          (!release &&
            row.status === "committed" &&
            Number(row.committed_amount) === amount)
        )
          return this.dto(row);
        throw new HttpError(
          409,
          "USAGE_SETTLEMENT",
          "이미 확정·해제·만료된 예약입니다.",
        );
      }
      if (amount > Number(row.amount))
        throw new HttpError(
          409,
          "USAGE_OVERRUN",
          "실제 사용량이 예약을 초과합니다. 추가 예약 후 처리하세요.",
        );
      this.db
        .prepare(
          "UPDATE expansion_usage_reservations SET status=?,committed_amount=? WHERE id=?",
        )
        .run(release ? "released" : "committed", amount, id);
      return this.dto(
        one(
          this.db,
          "SELECT * FROM expansion_usage_reservations WHERE id=?",
          id,
        )!,
      );
    });
  }
  observe(scope:ExpansionScope,operationId:string,metricInput:string,amountInput:number,reservationId?:string):void {
    const metric=this.metric(metricInput),amount=integer(amountInput,'측정 사용량',0,Number.MAX_SAFE_INTEGER),environment=scope.environmentId??'',digestValue=digest([scope,metric,amount,reservationId??null]);
    transaction(this.db,()=>{const old=one(this.db,'SELECT fingerprint FROM advancement_usage_entries WHERE operation_id=? AND metric=? AND environment_id=?',operationId,metric,environment);if(old){if(old.fingerprint!==digestValue)throw new HttpError(409,'USAGE_OBSERVATION_CONFLICT','동일 측정 작업의 사용량이 다릅니다.');return;}
      if(reservationId&&!one(this.db,'SELECT id FROM expansion_usage_reservations WHERE id=? AND organization_id=? AND project_id=? AND metric=? AND COALESCE(environment_id,\'\')=?',reservationId,scope.organizationId,scope.projectId,metric,environment))throw new HttpError(403,'USAGE_EVIDENCE_SCOPE','측정 작업과 예약 범위 또는 단위가 다릅니다.');
      this.db.prepare('INSERT INTO advancement_usage_entries VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),text(operationId,'측정 작업',200),scope.organizationId,scope.projectId,environment,metric,/bytes/i.test(metric)?'bytes':/cpu/i.test(metric)?'milliseconds':/tokens/i.test(metric)?'tokens':'count',amount,reservationId??null,digestValue,now());
    });this.expire();
  }
  evidence(scope:ExpansionScope):{actual:SqlRow[];aggregate:SqlRow[];costs:SqlRow[]} {return {actual:many(this.db,'SELECT operation_id AS operationId,metric,unit,amount,reservation_id AS reservationId,created_at AS createdAt FROM advancement_usage_entries WHERE organization_id=? AND project_id=? AND environment_id=? ORDER BY rowid DESC LIMIT 200',scope.organizationId,scope.projectId,scope.environmentId??''),aggregate:many(this.db,"SELECT metric,unit,SUM(amount) AS amount,'sum' AS mode,MAX(created_at) AS observedAt FROM advancement_usage_entries WHERE organization_id=? AND project_id=? AND environment_id=? AND metric<>'storageBytes' GROUP BY metric,unit UNION ALL SELECT metric,unit,amount,'latest-snapshot' AS mode,created_at AS observedAt FROM advancement_usage_entries WHERE rowid=(SELECT MAX(rowid) FROM advancement_usage_entries WHERE organization_id=? AND project_id=? AND environment_id=? AND metric='storageBytes')",scope.organizationId,scope.projectId,scope.environmentId??'',scope.organizationId,scope.projectId,scope.environmentId??''),costs:many(this.db,'SELECT operation_id AS operationId,kind,amount_minor AS amountMinor,currency,source,evidence_hash AS evidenceHash,created_at AS createdAt FROM advancement_usage_costs WHERE organization_id=? AND project_id=? AND environment_id=? ORDER BY created_at DESC LIMIT 200',scope.organizationId,scope.projectId,scope.environmentId??'')};}
  recordCost(scope:ExpansionScope,input:Record<string,unknown>):void {const kind=input.kind;if(!['estimate','provider-invoice'].includes(String(kind)))throw new HttpError(400,'USAGE_COST_KIND','예상 비용 또는 제공자 청구 근거를 지정하세요.');const currency=text(input.currency,'통화',3),amount=integer(input.amountMinor,'비용',0,Number.MAX_SAFE_INTEGER),source=text(input.source,'근거 ID',200),proof=text(input.evidenceHash,'근거 해시',64),operationId=text(input.operationId,'작업 ID',200);if(!/^[A-Z]{3}$/.test(currency)||!/^[a-f0-9]{64}$/.test(proof))throw new HttpError(400,'USAGE_COST_EVIDENCE','통화와 실제 근거 해시를 확인하세요.');const old=one(this.db,'SELECT * FROM advancement_usage_costs WHERE environment_id=? AND kind=? AND source=?',scope.environmentId??'',String(kind),source);if(old){if(old.evidence_hash!==proof||old.amount_minor!==amount||old.currency!==currency||old.operation_id!==operationId)throw new HttpError(409,'USAGE_COST_CONFLICT','같은 비용 근거의 내용이 다릅니다.');return;}this.db.prepare('INSERT INTO advancement_usage_costs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),operationId,scope.organizationId,scope.projectId,scope.environmentId??'',String(kind),amount,currency,source,proof,now());}
}
