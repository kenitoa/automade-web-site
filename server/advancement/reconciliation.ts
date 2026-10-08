import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ExpansionScope } from "../../src/domain/expansion";
import type { ReconciliationCase } from "../../src/domain/advancement";
import { HttpError } from "../http";
import { integer, many, now, one, text } from "../platform/common";
import { reconcileOrder } from "../platform/business";
import type { Transport } from "../platform/connections";
import { fingerprint } from "./common";
export class EvidenceService {
  constructor(readonly db: DatabaseSync) {}
  private dto(row: Record<string, unknown>): ReconciliationCase {
    return {
      id: String(row.id),
      scope: JSON.parse(String(row.scope)),
      kind: String(row.kind) as ReconciliationCase["kind"],
      targetId: String(row.target_id),
      revision: Number(row.revision),
      status: String(row.status) as ReconciliationCase["status"],
      evidence: row.evidence ? JSON.parse(String(row.evidence)) : null,
      resolution: row.resolution
        ? (String(row.resolution) as ReconciliationCase["resolution"])
        : null,
    };
  }
  list(scope: ExpansionScope): ReconciliationCase[] {
    return many(
      this.db,
      "SELECT * FROM advancement_reconciliation WHERE json_extract(scope,'$.organizationId')=? AND json_extract(scope,'$.projectId')=? AND COALESCE(json_extract(scope,'$.environmentId'),'')=? ORDER BY created_at DESC LIMIT 200",
      scope.organizationId,
      scope.projectId,
      scope.environmentId ?? "",
    ).map((row) => this.dto(row));
  }
  create(
    scope: ExpansionScope,
    input: Record<string, unknown>,
  ): ReconciliationCase {
    if (
      !["payment", "deployment", "work", "restore"].includes(String(input.kind))
    )
      throw new HttpError(
        400,
        "RECONCILIATION_KIND",
        "대사 종류를 확인하세요.",
      );
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO advancement_reconciliation VALUES(?,?,?,?,1,'open',NULL,NULL,?)",
      )
      .run(
        id,
        JSON.stringify(scope),
        String(input.kind),
        text(input.targetId, "대상 ID", 200),
        now(),
      );
    return this.list(scope).find((row) => row.id === id)!;
  }
  async verify(
    scope: ExpansionScope,
    id: string,
    base: number,
    site: DatabaseSync,
    assertCurrent: () => void,
    external?: (
      kind: ReconciliationCase["kind"],
      target: string,
    ) => Promise<{
      source: string;
      resolution: "completed" | "no-effect";
      evidence: unknown;
    }>,
    transport?: Transport,
  ): Promise<ReconciliationCase> {
    const current = this.list(scope).find((item) => item.id === id);
    if (!current || current.revision !== integer(base, "대사 revision", 1))
      throw new HttpError(
        409,
        "RECONCILIATION_CONFLICT",
        "현재 대사 revision을 확인하세요.",
      );
    let proof: {
      source: string;
      resolution: "completed" | "no-effect";
      evidence: unknown;
    };
    if (current.kind === "payment") {
      const order = one(
        site,
        "SELECT project_id FROM platform_orders WHERE id=?",
        current.targetId,
      );
      if (!order || order.project_id !== scope.projectId)
        throw new HttpError(
          403,
          "PAYMENT_SCOPE",
          "이 환경의 주문을 선택하세요.",
        );
      await reconcileOrder(
        site,
        current.targetId,
        transport,
        assertCurrent,
      );
      const result=one(site,"SELECT status,provider_sequence,amount_minor,refunded_minor FROM platform_orders WHERE id=? AND project_id=?",current.targetId,scope.projectId)!;
      if (
        !["paid", "partially_refunded", "refunded", "cancelled"].includes(
          String(result.status),
        )
      )
        throw new HttpError(
          409,
          "PAYMENT_UNCONFIRMED",
          "공급자의 확정 상태를 아직 확인하지 못했습니다.",
        );
      proof = {
        source: "provider-server-status",
        resolution: "completed",
        evidence: {
          orderId: current.targetId,
          status: result.status,
          sequence: result.provider_sequence,
          amountMinor: result.amount_minor,
          refundedMinor: result.refunded_minor,
        },
      };
    } else {
      if (!external)
        throw new HttpError(
          503,
          "EVIDENCE_PROVIDER_REQUIRED",
          "해당 작업의 공급자 상태 조회 연결이 필요합니다.",
        );
      proof = await external(current.kind, current.targetId);
    }
    if(!['completed','no-effect'].includes(proof.resolution)||proof.evidence===null||proof.evidence===undefined)throw new HttpError(502,'EVIDENCE_SCHEMA','공급자의 확정 판정과 검증 자료가 필요합니다.');
    assertCurrent();
    const evidence = {
        source: text(proof.source, "증거 출처", 100),
        fingerprint: fingerprint(proof.evidence),
        observedAt: now(),
      },
      changed = this.db
        .prepare(
          "UPDATE advancement_reconciliation SET status='verified',evidence=?,resolution=?,revision=revision+1 WHERE id=? AND revision=?",
        )
        .run(JSON.stringify(evidence), proof.resolution, id, base);
    if (!changed.changes)
      throw new HttpError(
        409,
        "RECONCILIATION_CONFLICT",
        "대사 중 다른 결정이 적용되었습니다.",
      );
    return this.list(scope).find((item) => item.id === id)!;
  }
  assertRetry(scope: ExpansionScope, targetId: string): void {
    const proof = this.list(scope).find(
      (item) =>
        item.kind === "work" &&
        item.targetId === targetId &&
        item.status === "verified" &&
        item.resolution === "no-effect",
    );
    if (!proof)
      throw new HttpError(
        409,
        "UNKNOWN_EVIDENCE_REQUIRED",
        "효과 없음이 확인된 대사 근거가 있어야 재실행할 수 있습니다.",
      );
  }
}
