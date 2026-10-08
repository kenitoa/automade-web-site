import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { record } from "../../src/domain/validation";
import { HttpError } from "../http";
import { audit, integer, many, now, one, text, type SqlRow } from "../platform/common";
import { enqueue, externalData, getConnection } from "../platform/connections";
const validPath = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]{1,200}$/.test(value) && !value.split(".").some(part => ["__proto__", "constructor", "prototype"].includes(part));
export function readPath(value: unknown, path: string): unknown { if (!validPath(path)) throw new HttpError(400, "MAPPING", "매핑 경로를 확인하세요."); let current = value; for (const key of path.split(".")) { if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined; current = (current as Record<string, unknown>)[key]; } return current; }
export class AdapterService {
  constructor(readonly db: DatabaseSync) {}
  list(organizationId: string): SqlRow[] { return many(this.db, "SELECT id,name,kind,version,protocol,mapping,updated_at AS updatedAt FROM expansion_adapters WHERE organization_id=? ORDER BY name LIMIT 200", organizationId).map(row => ({ ...row, mapping: JSON.parse(String(row.mapping)) as unknown })); }
  save(organizationId: string, input: Record<string, unknown>, id?: string): SqlRow {
    const kind = text(input.kind, "공급자 종류", 20); if (!["mail", "crm", "data", "payment"].includes(kind)) throw new HttpError(400, "ADAPTER_KIND", "공급자 종류를 확인하세요.");
    const mapping = record(input.mapping ?? {}); if (Object.entries(mapping).length > 50 || Object.entries(mapping).some(([key, value]) => !/^[A-Za-z0-9_-]{1,80}$/.test(key) || !validPath(value))) throw new HttpError(400, "MAPPING", "매핑을 확인하세요.");
    const key = id ?? randomUUID(), previous = one(this.db, "SELECT * FROM expansion_adapters WHERE id=? AND organization_id=?", key, organizationId);
    if (id && !previous) throw new HttpError(404, "ADAPTER", "공급자 어댑터를 찾을 수 없습니다.");
    if (previous && Number(previous.version) !== integer(input.baseVersion, "버전", 1)) throw new HttpError(409, "ADAPTER_CONFLICT", "공급자 설정이 변경되었습니다.");
    this.db.prepare("INSERT INTO expansion_adapters VALUES(?,?,?,?,?,'generic-json',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,version=excluded.version,mapping=excluded.mapping,updated_at=excluded.updated_at").run(key, organizationId, text(input.name, "어댑터 이름", 100), kind, Number(previous?.version ?? 0) + 1, JSON.stringify(mapping), now()); audit(this.db, "adapter.save", key); return this.list(organizationId).find(row => row.id === key)!;
  }
  async execute(organizationId: string, siteDb: DatabaseSync, projectId: string, id: string, input: Record<string, unknown>): Promise<unknown> {
    const adapter = one(this.db, "SELECT * FROM expansion_adapters WHERE id=? AND organization_id=?", id, organizationId); if (!adapter) throw new HttpError(404, "ADAPTER", "공급자 어댑터를 찾을 수 없습니다.");
    const connection = getConnection(siteDb, text(input.connectionId, "연결 ID", 100)); if (connection.projectId !== projectId || connection.kind !== adapter.kind) throw new HttpError(403, "ADAPTER_SCOPE", "연결 범위 또는 공급자 종류가 다릅니다.");
    if (connection.kind === "payment") throw new HttpError(400, "PAYMENT_ROUTE", "결제는 서버 주문 또는 플랫폼 구독 API를 사용하세요.");
    const mapping = JSON.parse(String(adapter.mapping)) as Record<string, string>;
    if (connection.kind === "data") { const result = await externalData(siteDb, connection.id, Boolean(input.refresh)), rows = Array.isArray(result.rows) ? result.rows : []; return { ...result, rows: rows.map(row => Object.fromEntries(Object.entries(mapping).map(([key, path]) => [key, readPath(row, path) ?? null]))) }; }
    const payload = record(input.payload), mapped = Object.fromEntries(Object.entries(mapping).map(([key, path]) => [key, readPath(payload, path) ?? null]));
    const idempotencyKey = text(input.key, "멱등성 키", 100), outboxId = enqueue(siteDb, projectId, connection.id, `adapter.${id}.${idempotencyKey}`, Object.keys(mapping).length ? mapped : payload);
    return { outboxId, status: "pending", adapterVersion: Number(adapter.version) };
  }
}
