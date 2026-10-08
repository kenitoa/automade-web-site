import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ExpansionScope } from "../../src/domain/expansion";
import type { PrivacyRequest } from "../../src/domain/advancement";
import { HttpError } from "../http";
import { many, now, one, text, transaction } from "../platform/common";
export class PrivacyService {
  constructor(readonly db: DatabaseSync) {}
  list(scope: ExpansionScope): PrivacyRequest[] {
    return many(
      this.db,
      "SELECT * FROM advancement_privacy_requests WHERE json_extract(scope,'$.projectId')=? AND json_extract(scope,'$.organizationId')=? AND COALESCE(json_extract(scope,'$.environmentId'),'')=? ORDER BY created_at DESC LIMIT 200",
      scope.projectId,
      scope.organizationId,
      scope.environmentId??'',
    ).map((row) => ({
      id: String(row.id),
      scope: JSON.parse(String(row.scope)),
      subjectId: String(row.subject_id),
      action: String(row.action) as PrivacyRequest["action"],
      status: String(row.status) as PrivacyRequest["status"],
      heldReason: row.held_reason ? String(row.held_reason) : null,
      counts: JSON.parse(String(row.counts)),
      createdAt: String(row.created_at),
    }));
  }
  create(
    scope: ExpansionScope,
    site: DatabaseSync,
    input: Record<string, unknown>,
  ): PrivacyRequest {
    const subject = text(input.subjectId, "회원 ID", 100);
    if (
      !one(site, "SELECT id FROM platform_accounts WHERE id=?", subject) ||
      !one(
        site,
        "SELECT 1 FROM platform_memberships WHERE account_id=? AND project_id=?",
        subject,
        scope.projectId,
      )
    )
      throw new HttpError(
        404,
        "PRIVACY_SUBJECT",
        "이 사이트의 회원을 선택하세요.",
      );
    if (!["export", "anonymize"].includes(String(input.action)))
      throw new HttpError(
        400,
        "PRIVACY_ACTION",
        "개인 자료 내보내기 또는 비식별화를 선택하세요.",
      );
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO advancement_privacy_requests VALUES(?,?,?,?, 'requested',NULL,'{}',?)",
      )
      .run(id, JSON.stringify(scope), subject, String(input.action), now());
    return this.list(scope).find((item) => item.id === id)!;
  }
  run(
    scope: ExpansionScope,
    id: string,
    site: DatabaseSync,
  ): { request: PrivacyRequest; data?: Record<string, unknown> } {
    const request = this.list(scope).find((item) => item.id === id);
    if (!request)
      throw new HttpError(
        404,
        "PRIVACY_REQUEST",
        "개인 자료 요청을 찾을 수 없습니다.",
      );
    const account = one(
      site,
      "SELECT id,email,display_name,created_at FROM platform_accounts WHERE id=?",
      request.subjectId,
    );
    if (!account)
      throw new HttpError(
        404,
        "PRIVACY_SUBJECT",
        "회원 자료를 찾을 수 없습니다.",
      );
    const orders = many(
        site,
        "SELECT id,status,amount_minor,currency,refunded_minor,created_at FROM platform_orders WHERE project_id=? AND account_id=? ORDER BY created_at LIMIT 1000",
        scope.projectId,
        request.subjectId,
      ),
      bookings = many(
        site,
        "SELECT id,slot_id,quantity,status,created_at FROM platform_bookings WHERE project_id=? AND account_id=? ORDER BY created_at LIMIT 1000",
        scope.projectId,
        request.subjectId,
      ),
      counts = {
        accounts: 1,
        orders: orders.length,
        bookings: bookings.length,
      };
    if (request.action === "export") {
      this.db
        .prepare(
          "UPDATE advancement_privacy_requests SET status='completed',counts=? WHERE id=?",
        )
        .run(JSON.stringify(counts), id);
      return {
        request: this.list(scope).find((item) => item.id === id)!,
        data: { account, orders, bookings, bounded: true, limitPerKind: 1000 },
      };
    }
    if (request.status === "completed") return { request };
    const held =
      orders.length > 0 || bookings.some((row) => row.status === "confirmed");
    if (held) {
      this.db
        .prepare(
          "UPDATE advancement_privacy_requests SET status='held',held_reason='TRANSACTION_RETENTION_REVIEW_REQUIRED',counts=? WHERE id=?",
        )
        .run(JSON.stringify(counts), id);
      return { request: this.list(scope).find((item) => item.id === id)! };
    }
    this.db
      .prepare(
        "INSERT INTO advancement_privacy_markers VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(scope.projectId,scope.environmentId??'', request.subjectId, now());
    transaction(site, () => {
      site
        .prepare(
          "UPDATE platform_accounts SET email=?,display_name='[비식별화]',password_hash=? WHERE id=?",
        )
        .run(
          `masked-${request.subjectId}@example.invalid`,
          randomBytes(48).toString("hex"),
          request.subjectId,
        );
      site
        .prepare("DELETE FROM platform_sessions WHERE account_id=?")
        .run(request.subjectId);
      site
        .prepare("DELETE FROM platform_reset_tokens WHERE account_id=?")
        .run(request.subjectId);
      site
        .prepare(
          "UPDATE platform_invites SET status='revoked' WHERE project_id=? AND email=?",
        )
        .run(scope.projectId, String(account.email));
    });
    // Unstructured form and external payload review remains explicit, rather than claiming a complete erasure.
    this.db
      .prepare(
        "UPDATE advancement_privacy_requests SET status='held',held_reason='UNSTRUCTURED_PAYLOAD_REVIEW_REQUIRED',counts=? WHERE id=?",
      )
      .run(JSON.stringify(counts), id);
    return { request: this.list(scope).find((item) => item.id === id)! };
  }
  reapply(scope: ExpansionScope, site: DatabaseSync): void {
    for (const row of many(
      this.db,
      "SELECT subject_id FROM advancement_privacy_markers WHERE project_id=? AND environment_id=?",
      scope.projectId,
      scope.environmentId??'',
    )) {
      site
        .prepare(
          "UPDATE platform_accounts SET email=?,display_name='[비식별화]',password_hash=? WHERE id=?",
        )
        .run(
          `masked-${String(row.subject_id)}@example.invalid`,
          randomBytes(48).toString("hex"),
          String(row.subject_id),
        );
      site
        .prepare("DELETE FROM platform_sessions WHERE account_id=?")
        .run(String(row.subject_id));
    }
  }
}
