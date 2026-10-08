import { randomUUID } from "node:crypto";
import type { ExpansionScope, FieldComment, PresenceEntry, RevisionReview } from "../../src/domain/expansion";
import { transitionContent, validateCmsRecord } from "../../src/domain/cms";
import type { ContentRecord, ContentWorkflow, Project } from "../../src/domain/types";
import { parseProject } from "../../src/domain/validation";
import { HttpError } from "../http";
import type { Store } from "../store";
import { audit, hash, integer, many, now, one, text, transaction, type SqlRow } from "../platform/common";
export function contentFingerprint(value: ContentRecord): string { const { workflow: _workflow, status: _status, contentRevision: _revision, publishedAt: _publishedAt, ...content } = value; return hash(JSON.stringify(content)); }

export class ReviewService {
  constructor(readonly store: Store, readonly assertApprover: (scope: ExpansionScope, accountId: string) => void = () => {}) {}
  snapshot(project: Project): string { const fingerprint = hash(JSON.stringify(project)); this.store.db.prepare("INSERT INTO expansion_revision_snapshots VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").run(project.id, project.revision, JSON.stringify(project), fingerprint, now()); return fingerprint; }
  private review(row: SqlRow): RevisionReview { return { id: String(row.id), scope: { organizationId: String(row.organization_id), workspaceId: String(row.workspace_id), projectId: String(row.project_id) }, revision: Number(row.revision), fingerprint: String(row.fingerprint), status: String(row.status) as RevisionReview["status"], createdBy: String(row.created_by), decidedBy: row.decided_by ? String(row.decided_by) : null, createdAt: String(row.created_at) }; }
  list(scope: ExpansionScope): RevisionReview[] { return many(this.store.db, "SELECT * FROM expansion_reviews WHERE project_id=? AND organization_id=? ORDER BY created_at DESC LIMIT 200", scope.projectId, scope.organizationId).map(row => this.review(row)); }
  submit(scope: ExpansionScope, actor: string, revision: number): RevisionReview {
    const project = this.store.project(scope.projectId); if (!project || project.revision !== revision) throw new HttpError(409, "REVIEW_REVISION", "현재 문서 버전으로 검토를 요청하세요.");
    const fingerprint = this.snapshot(project), old = one(this.store.db, "SELECT * FROM expansion_reviews WHERE project_id=? AND revision=? AND fingerprint=? AND status='pending' AND created_by=?", scope.projectId, revision, fingerprint, actor);
    if (old) return this.review(old);
    const id = randomUUID(); this.store.db.prepare("INSERT INTO expansion_reviews VALUES(?,?,?,?,?,?,'pending',?,NULL,?,NULL)").run(id, scope.organizationId, scope.workspaceId, scope.projectId, revision, fingerprint, actor, now()); audit(this.store.db, "revision.review.request", id); return this.review(one(this.store.db, "SELECT * FROM expansion_reviews WHERE id=?", id)!);
  }
  decide(scope: ExpansionScope, actor: string, id: string, decision: unknown): RevisionReview {
    if (!["approved", "changes_requested"].includes(String(decision))) throw new HttpError(400, "REVIEW_DECISION", "검토 결정을 확인하세요.");
    return transaction(this.store.db, () => {
      const row = one(this.store.db, "SELECT * FROM expansion_reviews WHERE id=? AND project_id=? AND organization_id=?", id, scope.projectId, scope.organizationId), project = this.store.project(scope.projectId);
      if (!row) throw new HttpError(404, "REVIEW", "검토 요청을 찾을 수 없습니다.");
      if (row.created_by === actor) throw new HttpError(403, "SELF_APPROVAL", "자신의 검토 요청을 승인할 수 없습니다.");
      if (row.status !== "pending") throw new HttpError(409, "REVIEW_DECIDED", "이미 결정된 검토입니다.");
      if (!project || project.revision !== Number(row.revision) || hash(JSON.stringify(project)) !== row.fingerprint) throw new HttpError(409, "REVIEW_STALE", "검토 후 문서가 변경되었습니다. 현재 버전을 다시 요청하세요.");
      this.store.db.prepare("UPDATE expansion_reviews SET status=?,decided_by=?,decided_at=? WHERE id=?").run(String(decision), actor, now(), id); audit(this.store.db, "revision.review.decide", id); return this.review(one(this.store.db, "SELECT * FROM expansion_reviews WHERE id=?", id)!);
    });
  }
  comments(scope: ExpansionScope): FieldComment[] { return many(this.store.db, "SELECT * FROM expansion_field_comments WHERE project_id=? ORDER BY created_at DESC LIMIT 500", scope.projectId).map(row => ({ id: String(row.id), projectId: String(row.project_id), revision: Number(row.revision), targetPath: String(row.target_path), body: String(row.body), authorId: String(row.author_id), resolved: Boolean(row.resolved), createdAt: String(row.created_at) })); }
  target(value: unknown): string { const path = text(value, "필드 경로", 300); if (!/^(?:project|theme|settings|pages|blocks|collections)(?:\.[A-Za-z0-9_-]+)*$/.test(path) || path.split(".").some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw new HttpError(400, "COMMENT_TARGET", "문서 필드 경로를 확인하세요."); return path; }
  comment(scope: ExpansionScope, actor: string, input: Record<string, unknown>): FieldComment { const revision = integer(input.revision, "문서 버전"), project = this.store.project(scope.projectId); if (!project || project.revision !== revision) throw new HttpError(409, "COMMENT_REVISION", "현재 문서 버전에 의견을 남기세요."); const id = randomUUID(); this.store.db.prepare("INSERT INTO expansion_field_comments VALUES(?,?,?,?,?,?,0,?)").run(id, scope.projectId, revision, this.target(input.targetPath), text(input.body, "의견", 5000), actor, now()); return this.comments(scope).find(item => item.id === id)!; }
  resolveComment(scope: ExpansionScope, id: string, resolved: boolean): void { const result = this.store.db.prepare("UPDATE expansion_field_comments SET resolved=? WHERE id=? AND project_id=?").run(resolved ? 1 : 0, id, scope.projectId); if (!result.changes) throw new HttpError(404, "COMMENT", "의견을 찾을 수 없습니다."); }
  presence(scope: ExpansionScope): PresenceEntry[] { this.store.db.prepare("DELETE FROM expansion_presence WHERE expires_at<=?").run(Date.now()); return many(this.store.db, "SELECT p.*,a.display_name FROM expansion_presence p JOIN creator_accounts a ON a.id=p.account_id WHERE p.project_id=? AND a.disabled=0 ORDER BY a.display_name LIMIT 100", scope.projectId).map(row => ({ accountId: String(row.account_id), displayName: String(row.display_name), projectId: scope.projectId, revision: Number(row.revision), targetPath: String(row.target_path), expiresAt: new Date(Number(row.expires_at)).toISOString() })); }
  heartbeat(scope: ExpansionScope, accountId: string, input: Record<string, unknown>): void { if (!one(this.store.db, "SELECT id FROM creator_accounts WHERE id=? AND disabled=0", accountId)) throw new HttpError(401, "CREATOR_REQUIRED", "동시 편집 상태에는 제작자 계정이 필요합니다."); this.store.db.prepare("INSERT INTO expansion_presence VALUES(?,?,?,?,?) ON CONFLICT DO UPDATE SET revision=excluded.revision,target_path=excluded.target_path,expires_at=excluded.expires_at").run(scope.projectId, accountId, integer(input.revision, "버전"), this.target(input.targetPath ?? "project"), Date.now() + 60_000); }
  content(scope: ExpansionScope, actor: string, input: Record<string, unknown>): { project: Project; scheduledAt?: number; recordId: string; contentRevision: number } {
    const project = this.store.project(scope.projectId); if (!project) throw new HttpError(404, "PROJECT", "프로젝트를 찾을 수 없습니다.");
    if (project.revision !== integer(input.baseRevision, "문서 버전")) throw new HttpError(409, "CONTENT_CONFLICT", "문서가 변경되었습니다.");
    const collection = project.collections?.find(item => item.id === input.collectionId), record = collection?.records.find(item => item.id === input.recordId);
    if (!collection || !record) throw new HttpError(404, "CONTENT_RECORD", "콘텐츠를 찾을 수 없습니다.");
    const state = String(input.state) as ContentWorkflow["state"], contentRevision = record.contentRevision ?? 0;
    if (!["draft", "review", "approved", "scheduled", "published", "archived"].includes(state)) throw new HttpError(400, "CONTENT_STATE", "콘텐츠 상태를 확인하세요.");
    const author = one(this.store.db, "SELECT * FROM expansion_content_authors WHERE project_id=? AND collection_id=? AND record_id=? AND content_revision=?", scope.projectId, collection.id, record.id, contentRevision);
    if (state === "approved" && (!author || author.submitted_by === actor)) throw new HttpError(403, "CONTENT_APPROVER", "현재 내용을 제출한 제작자와 다른 검토자가 승인해야 합니다.");
    const approval = this.store.operations.state(`cms:approval:${scope.projectId}:${collection.id}:${record.id}:${contentRevision}`);
    if (["scheduled", "published"].includes(state) && (!author?.approved_by || !approval || typeof approval !== "object" || (approval as Record<string, unknown>).fingerprint !== contentFingerprint(record))) throw new HttpError(403, "CONTENT_APPROVAL", "현재 콘텐츠 버전의 서버 승인이 필요합니다.");
    const errors = validateCmsRecord(project, collection, record); if (errors.length && !["draft", "archived"].includes(state)) throw new HttpError(400, "CMS_VALUES", errors.join(" "));
    if (["scheduled", "published"].includes(state)) this.assertApprover(scope, String(author!.approved_by));
    const next = transitionContent(record, state, input.publishAt === undefined ? undefined : text(input.publishAt, "예약 시각", 50)), scheduledAt = state === "scheduled" ? Date.parse(next.workflow!.publishAt!) : undefined;
    if (scheduledAt !== undefined && (scheduledAt < Date.now() || scheduledAt > Date.now() + 365 * 86400_000)) throw new HttpError(400, "CONTENT_SCHEDULE", "예약 시각은 향후 1년 이내여야 합니다.");
    const changed = parseProject({ ...project, revision: project.revision + 1, updatedAt: now(), collections: project.collections!.map(item => item.id === collection.id ? { ...item, records: item.records.map(item => item.id === record.id ? next : item) } : item) });
    this.store.save(changed, project.revision);
    if (state === "review") this.store.db.prepare("INSERT INTO expansion_content_authors VALUES(?,?,?,?,?,NULL) ON CONFLICT DO UPDATE SET submitted_by=excluded.submitted_by,approved_by=NULL").run(scope.projectId, collection.id, record.id, contentRevision, actor);
    if (state === "approved") this.store.db.prepare("UPDATE expansion_content_authors SET approved_by=? WHERE project_id=? AND collection_id=? AND record_id=? AND content_revision=?").run(actor, scope.projectId, collection.id, record.id, contentRevision);
    if (state === "approved") this.store.operations.setState(`cms:approval:${scope.projectId}:${collection.id}:${record.id}:${contentRevision}`, { fingerprint: contentFingerprint(record), actorId: actor, approvedAt: now() });
    audit(this.store.db, "content." + state, record.id); return { project: changed, recordId: record.id, contentRevision, ...(scheduledAt === undefined ? {} : { scheduledAt }) };
  }
  publishScheduled(scope: ExpansionScope, payload: Record<string, unknown>): Project {
    const project = this.store.project(scope.projectId), collection = project?.collections?.find(item => item.id === payload.collectionId), record = collection?.records.find(item => item.id === payload.recordId);
    if (!project || !collection || !record) throw new HttpError(404, "CONTENT_RECORD", "예약 콘텐츠를 찾을 수 없습니다.");
    if (record.workflow?.state === "published" && record.contentRevision === payload.contentRevision) return project;
    if (record.workflow?.state !== "scheduled" || (record.contentRevision ?? 0) !== payload.contentRevision || record.workflow.publishAt !== payload.publishAt || record.workflow.approvedRevision !== (record.contentRevision ?? 0)) throw new HttpError(409, "CONTENT_SCHEDULE_STALE", "예약 후 콘텐츠가 변경되거나 회수되었습니다.");
    if (Date.parse(record.workflow.publishAt!) > Date.now()) throw new HttpError(409, "CONTENT_NOT_DUE", "예약 발행 시각이 아직 도착하지 않았습니다.");
    const approval = this.store.operations.state(`cms:approval:${scope.projectId}:${collection.id}:${record.id}:${record.contentRevision ?? 0}`);
    if (!approval || typeof approval !== "object" || (approval as Record<string, unknown>).fingerprint !== contentFingerprint(record)) throw new HttpError(409, "CONTENT_APPROVAL_STALE", "예약한 콘텐츠의 승인 내용이 변경되었습니다.");
    const approver = (approval as Record<string, unknown>).actorId; if (typeof approver !== "string") throw new HttpError(409, "CONTENT_APPROVAL_STALE", "예약한 콘텐츠의 승인 계정을 확인하세요."); this.assertApprover(scope, approver);
    const next = transitionContent(record, "published"), changed = parseProject({ ...project, revision: project.revision + 1, updatedAt: now(), collections: project.collections!.map(item => item.id === collection.id ? { ...item, records: item.records.map(item => item.id === record.id ? next : item) } : item) }); this.store.save(changed, project.revision); audit(this.store.db, "content.publish.job", record.id); return changed;
  }
}
