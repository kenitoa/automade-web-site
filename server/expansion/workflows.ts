import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AutomationRun, AutomationWorkflow, ExpansionScope, WorkflowAction, WorkflowCondition, WorkflowTrigger } from "../../src/domain/expansion";
import { record } from "../../src/domain/validation";
import { HttpError } from "../http";
import type { Store } from "../store";
import { enqueue, getConnection } from "../platform/connections";
import { audit, boolean, hash, integer, many, now, one, text, transaction, type SqlRow } from "../platform/common";
import { readPath } from "./adapters";

export const WORKFLOW_TRIGGERS: WorkflowTrigger[] = ["form.submitted", "order.paid", "booking.created", "manual"];
export function workflowDefinition(value: Record<string, unknown>): { conditions: WorkflowCondition[]; actions: WorkflowAction[] } {
  if (!Array.isArray(value.conditions) || value.conditions.length > 20 || !Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 20) throw new HttpError(400, "WORKFLOW", "조건과 실행 동작을 확인하세요.");
  const conditions = value.conditions.map(entry => { const item = record(entry), field = text(item.field, "조건 필드", 100); readPath({}, field); if (!["equals", "contains", "greaterThan"].includes(String(item.operator)) || item.value !== null && !["string", "number", "boolean"].includes(typeof item.value) || typeof item.value === "number" && !Number.isFinite(item.value) || typeof item.value === "string" && item.value.length > 2000) throw new HttpError(400, "WORKFLOW_CONDITION", "조건을 확인하세요."); return { field, operator: item.operator as WorkflowCondition["operator"], value: item.value as WorkflowCondition["value"] }; });
  const actions = value.actions.map((entry): WorkflowAction => {
    const item = record(entry);
    if (item.type === "submission.update") { if (item.status !== undefined && !["new", "processing", "completed", "archived"].includes(String(item.status))) throw new HttpError(400, "WORKFLOW_ACTION", "문의 상태를 확인하세요."); if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 20 || item.tags.some(tag => typeof tag !== "string" || tag.length > 60))) throw new HttpError(400, "WORKFLOW_ACTION", "태그를 확인하세요."); return { type: "submission.update", ...(item.status ? { status: item.status as "new" | "processing" | "completed" | "archived" } : {}), ...(item.tags ? { tags: item.tags as string[] } : {}), ...(item.assignee !== undefined ? { assignee: text(item.assignee, "담당자", 200, true) } : {}) }; }
    if (item.type === "connection.enqueue") { const template = record(item.template); if (Object.entries(template).length > 50 || Object.values(template).some(value => typeof value !== "string" || value.length > 2000) || Object.keys(template).some(key => !/^[A-Za-z0-9_-]{1,80}$/.test(key))) throw new HttpError(400, "WORKFLOW_TEMPLATE", "전송 템플릿을 확인하세요."); for (const value of Object.values(template)) for (const match of String(value).matchAll(/\{\{([^{}]+)\}\}/g)) readPath({}, match[1]!); return { type: "connection.enqueue", connectionId: text(item.connectionId, "연결 ID", 100), template: template as Record<string, string> }; }
    throw new HttpError(400, "WORKFLOW_ACTION", "지원하는 선언형 동작이 필요합니다.");
  }); return { conditions, actions };
}
export class WorkflowService {
  constructor(readonly db: DatabaseSync) {}
  private dto(row: SqlRow): AutomationWorkflow { const definition = workflowDefinition(record(JSON.parse(String(row.body)))); return { id: String(row.id), scope: { organizationId: String(row.organization_id), workspaceId: String(row.workspace_id), projectId: String(row.project_id), ...(row.environment_id ? { environmentId: String(row.environment_id) } : {}) }, name: String(row.name), trigger: String(row.trigger) as WorkflowTrigger, enabled: Boolean(row.enabled), ...definition, revision: Number(row.revision), updatedAt: String(row.updated_at) }; }
  list(scope: ExpansionScope): AutomationWorkflow[] { return many(this.db, "SELECT * FROM expansion_workflows WHERE organization_id=? AND project_id=? AND (environment_id IS NULL OR environment_id=?) ORDER BY updated_at DESC LIMIT 200", scope.organizationId, scope.projectId, scope.environmentId ?? null).map(row => this.dto(row)); }
  save(scope: ExpansionScope, actor: string, input: Record<string, unknown>, id?: string): AutomationWorkflow {
    const definition = workflowDefinition(input), trigger = input.trigger; if (!WORKFLOW_TRIGGERS.includes(trigger as WorkflowTrigger)) throw new HttpError(400, "WORKFLOW_TRIGGER", "자동화 시작 이벤트를 확인하세요.");
    const key = id ?? randomUUID(), previous = one(this.db, "SELECT * FROM expansion_workflows WHERE id=? AND project_id=? AND organization_id=?", key, scope.projectId, scope.organizationId);
    if (id && !previous) throw new HttpError(404, "WORKFLOW", "자동화를 찾을 수 없습니다.");
    if (previous && Number(previous.revision) !== integer(input.baseRevision, "자동화 버전", 1)) throw new HttpError(409, "WORKFLOW_CONFLICT", "자동화가 변경되었습니다.");
    this.db.prepare("INSERT INTO expansion_workflows VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,trigger=excluded.trigger,enabled=excluded.enabled,body=excluded.body,revision=excluded.revision,updated_at=excluded.updated_at").run(key, scope.organizationId, scope.workspaceId, scope.projectId, scope.environmentId ?? null, text(input.name, "자동화 이름", 100), String(trigger), boolean(input.enabled, "활성화", false) ? 1 : 0, JSON.stringify(definition), Number(previous?.revision ?? 0) + 1, actor, now());
    audit(this.db, "workflow.save", key); return this.dto(one(this.db, "SELECT * FROM expansion_workflows WHERE id=?", key)!);
  }
  private runDto(row: SqlRow): AutomationRun { return { id: String(row.id), workflowId: String(row.workflow_id), eventKey: String(row.event_key), status: String(row.status) as AutomationRun["status"], completedActions: Number(row.completed_actions), errorCode: row.error_code ? String(row.error_code) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
  runs(scope: ExpansionScope): AutomationRun[] { return many(this.db, "SELECT r.* FROM expansion_workflow_runs r JOIN expansion_workflows w ON w.id=r.workflow_id WHERE w.organization_id=? AND w.project_id=? ORDER BY r.created_at DESC LIMIT 200", scope.organizationId, scope.projectId).map(row => this.runDto(row)); }
  events(scope: ExpansionScope, trigger: WorkflowTrigger, payload: unknown, eventKey: string, actor?: string, selected?:{workflowId:string;expectedRevision:number}): string[] {
    if (!WORKFLOW_TRIGGERS.includes(trigger) || !payload || typeof payload !== "object" || Array.isArray(payload) || JSON.stringify(payload).length > 100_000) throw new HttpError(400, "WORKFLOW_EVENT", "이벤트 입력을 확인하세요.");
    const key = text(eventKey, "이벤트 키", 200), ids: string[] = [];
    transaction(this.db, () => {
      const available=this.list(scope);if(selected&&!available.some(item=>item.id===selected.workflowId&&item.revision===selected.expectedRevision&&item.enabled&&item.trigger===trigger))throw new HttpError(409,"WORKFLOW_REVIEW_STALE","검토한 자동화가 변경되었거나 비활성화되었습니다.");
      for (const workflow of available.filter(item => item.enabled && item.trigger === trigger&&(!selected||item.id===selected.workflowId))) {
        const matched = workflow.conditions.every(condition => { const value = readPath(payload, condition.field); return condition.operator === "equals" ? value === condition.value : condition.operator === "contains" ? typeof value === "string" && typeof condition.value === "string" && value.includes(condition.value) : typeof value === "number" && typeof condition.value === "number" && value > condition.value; });
        if (!matched) continue;
        const old = one(this.db, "SELECT id,payload FROM expansion_workflow_runs WHERE workflow_id=? AND event_key=?", workflow.id, key);
        if (old) { if (hash(String(old.payload)) !== hash(JSON.stringify(payload))) throw new HttpError(409, "WORKFLOW_EVENT_REPLAY", "동일 이벤트 내용이 다릅니다."); ids.push(String(old.id)); continue; }
        const id = randomUUID(), owner = actor ?? String(one(this.db, "SELECT created_by FROM expansion_workflows WHERE id=?", workflow.id)!.created_by);
        this.db.prepare("INSERT INTO expansion_workflow_runs(id,workflow_id,event_key,payload,status,completed_actions,error_code,created_at,updated_at,definition,actor_id) VALUES(?,?,?,?,'pending',0,NULL,?,?,?,?)").run(id, workflow.id, key, JSON.stringify(payload), now(), now(), JSON.stringify(workflow), owner); ids.push(id);
      }
    }); return ids;
  }
  runActor(id: string): string { return String(one(this.db, "SELECT actor_id FROM expansion_workflow_runs WHERE id=?", id)?.actor_id ?? "local-owner"); }
  async execute(scope: ExpansionScope, runId: string, siteData: () => Promise<Store>, authorize: (capability: "automation.manage" | "data.write" | "connection.use") => void, assertLease: () => void): Promise<AutomationRun> {
    const lease = Date.now() + 60_000;
    const row = transaction(this.db, () => {
      const run = one(this.db, "SELECT r.*,w.enabled,w.project_id,w.organization_id FROM expansion_workflow_runs r JOIN expansion_workflows w ON w.id=r.workflow_id WHERE r.id=?", runId);
      if (!run || run.project_id !== scope.projectId || run.organization_id !== scope.organizationId) throw new HttpError(404, "WORKFLOW_RUN", "자동화 실행을 찾을 수 없습니다.");
      if (!run.enabled) throw new HttpError(409, "WORKFLOW_PAUSED", "자동화가 중지되었습니다.");
      if (run.status === "completed") return run;
      if (run.status === "running" && Number(run.lease_until) > Date.now()) throw new HttpError(409, "WORKFLOW_BUSY", "자동화가 실행 중입니다.");
      this.db.prepare("UPDATE expansion_workflow_runs SET status='running',lease_until=?,error_code=NULL,updated_at=? WHERE id=?").run(lease, now(), runId); return run;
    });
    if (row.status === "completed") return this.runDto(row);
    const workflow = record(JSON.parse(String(row.definition))), definition = workflowDefinition(workflow), payload = record(JSON.parse(String(row.payload)));
    try {
      const site = await siteData();
      for (let index = Number(row.completed_actions); index < definition.actions.length; index++) {
        assertLease(); authorize("automation.manage");
        const current = one(this.db, "SELECT r.lease_until,w.enabled FROM expansion_workflow_runs r JOIN expansion_workflows w ON w.id=r.workflow_id WHERE r.id=?", runId);
        if (current?.lease_until !== lease || !current.enabled) throw new HttpError(409, "WORKFLOW_LEASE", "자동화 실행 권한이 변경되었습니다.");
        site.assertWritable(); const action = definition.actions[index]!;
        if (action.type === "submission.update") { authorize("data.write"); site.operations.updateSubmission(text(payload.submissionId ?? payload.id, "문의 ID", 100), action); }
        else { authorize("connection.use"); const connection = getConnection(site.db, action.connectionId); if (connection.projectId !== scope.projectId || !["mail", "crm"].includes(connection.kind)) throw new HttpError(403, "WORKFLOW_CONNECTION", "자동화 연결 범위 또는 종류가 다릅니다."); const mapped = Object.fromEntries(Object.entries(action.template).map(([key, template]) => [key, template.replace(/\{\{([^{}]+)\}\}/g, (_match, field: string) => { const value = readPath(payload, field); return ["string", "number", "boolean"].includes(typeof value) ? String(value) : ""; })])); enqueue(site.db, scope.projectId, connection.id, `workflow.${runId}.${index}`, mapped); }
        this.db.prepare("UPDATE expansion_workflow_runs SET completed_actions=?,updated_at=? WHERE id=? AND lease_until=?").run(index + 1, now(), runId, lease);
      }
      assertLease(); this.db.prepare("UPDATE expansion_workflow_runs SET status='completed',lease_until=0,updated_at=? WHERE id=? AND lease_until=?").run(now(), runId, lease);
    } catch (error) { this.db.prepare("UPDATE expansion_workflow_runs SET status='failed',lease_until=0,error_code=?,updated_at=? WHERE id=? AND lease_until=?").run(error instanceof HttpError ? error.code : "WORKFLOW_FAILED", now(), runId, lease); throw error; }
    return this.runDto(one(this.db, "SELECT * FROM expansion_workflow_runs WHERE id=?", runId)!);
  }
}
