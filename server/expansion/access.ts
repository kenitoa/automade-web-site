import type { DatabaseSync } from "node:sqlite";
import type { CreatorIdentity, ExpansionCapability, ExpansionScope, OrganizationRole } from "../../src/domain/expansion";
import { EXPANSION_CAPABILITIES } from "../../src/domain/expansion";
import { HttpError } from "../http";
import { many, one, text } from "../platform/common";

export function parseCapabilities(value: unknown): ExpansionCapability[] {
  if (!Array.isArray(value) || value.length > EXPANSION_CAPABILITIES.length || value.some(item => !EXPANSION_CAPABILITIES.includes(item as ExpansionCapability))) throw new HttpError(400, "CAPABILITY", "권한 목록을 확인하세요.");
  return [...new Set(value)] as ExpansionCapability[];
}
export function actorId(identity: CreatorIdentity | null, localOwner: boolean): string {
  if (identity) return identity.id;
  if (localOwner) return "local-owner";
  throw new HttpError(401, "LOGIN_REQUIRED", "제작자 로그인이 필요합니다.");
}
export class ExpansionAccess {
  constructor(readonly db: DatabaseSync, readonly mode: "local" | "managed") {}
  project(projectId: string): ExpansionScope {
    const row = one(this.db, "SELECT p.*,s.id AS site_id,e.id AS environment_id,e.data_key FROM expansion_project_scopes p LEFT JOIN expansion_sites s ON s.project_id=p.project_id AND s.archived=0 LEFT JOIN expansion_environments e ON e.site_id=s.id AND e.kind='production' WHERE p.project_id=? ORDER BY CASE WHEN s.id=p.project_id THEN 0 ELSE 1 END,CASE WHEN e.id=p.project_id||'-production' THEN 0 WHEN e.data_key=p.project_id THEN 1 ELSE 2 END,e.id LIMIT 1", projectId);
    if (!row) throw new HttpError(404, "PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
    return { organizationId: String(row.organization_id), workspaceId: String(row.workspace_id), projectId: String(row.project_id), ...(row.site_id ? { siteId: String(row.site_id) } : {}), ...(row.environment_id ? { environmentId: String(row.environment_id), dataKey: String(row.data_key) } : { dataKey: String(row.project_id) }) };
  }
  environment(id: string): ExpansionScope {
    const row = one(this.db, "SELECT * FROM expansion_environments WHERE id=?", id);
    if (!row) throw new HttpError(404, "ENVIRONMENT_NOT_FOUND", "환경을 찾을 수 없습니다.");
    return { organizationId: String(row.organization_id), workspaceId: String(row.workspace_id), projectId: String(row.project_id), siteId: String(row.site_id), environmentId: String(row.id), dataKey: String(row.data_key) };
  }
  resolve(value: Partial<ExpansionScope>): ExpansionScope {
    const scope = value.environmentId ? this.environment(value.environmentId) : this.project(text(value.projectId, "프로젝트 ID", 100));
    for (const key of ["organizationId", "workspaceId", "projectId", "siteId", "environmentId", "dataKey"] as const) if (value[key] !== undefined && value[key] !== scope[key]) throw new HttpError(403, "SCOPE_MISMATCH", "리소스 소유 범위가 일치하지 않습니다.");
    return scope;
  }
  role(id: string, organizationId: string): OrganizationRole | null {
    const row = one(this.db, "SELECT role FROM expansion_memberships WHERE organization_id=? AND account_id=?", organizationId, id);
    return row ? String(row.role) as OrganizationRole : null;
  }
  capabilities(identity: CreatorIdentity | null, scope: ExpansionScope, localOwner = false): ExpansionCapability[] {
    if (localOwner && this.mode === "local") return [...EXPANSION_CAPABILITIES];
    if (!identity) return [];
    if (one(this.db,"SELECT name FROM sqlite_master WHERE name='advancement_service_identities'")) {
      const service=one(this.db,"SELECT * FROM advancement_service_identities WHERE id=? AND revoked=0 AND expires_at>?",identity.id,Date.now());
      if(service){const owned=JSON.parse(String(service.scope)) as ExpansionScope;if(owned.organizationId!==scope.organizationId||owned.workspaceId!==scope.workspaceId||owned.projectId!==scope.projectId||(owned.environmentId&&owned.environmentId!==scope.environmentId))return [];return parseCapabilities(JSON.parse(String(service.capabilities)));}
    }
    const role = this.role(identity.id, scope.organizationId);
    if (role === "owner") return [...EXPANSION_CAPABILITIES];
    if (role === "admin") return EXPANSION_CAPABILITIES.filter(capability => capability !== "org.manage" && capability !== "billing.manage" && capability !== "secret.rotate");
    if (role === "billing") return ["billing.manage"];
    if (!role) return [];
    const grants = many(this.db, "SELECT capabilities FROM expansion_workspace_grants WHERE workspace_id=? AND account_id=? UNION ALL SELECT capabilities FROM expansion_project_grants WHERE project_id=? AND account_id=?", scope.workspaceId, identity.id, scope.projectId, identity.id);
    const delegated=one(this.db,"SELECT name FROM sqlite_master WHERE name='advancement_support_sessions'")?many(this.db,"SELECT s.capabilities,s.scope FROM advancement_support_sessions s JOIN expansion_memberships m ON m.account_id=s.approved_by WHERE s.support_id=? AND s.revoked=0 AND s.expires_at>? AND m.organization_id=? AND m.role IN('owner','admin')",identity.id,Date.now(),scope.organizationId).filter(row=>{const owned=JSON.parse(String(row.scope)) as ExpansionScope;return owned.organizationId===scope.organizationId&&owned.projectId===scope.projectId&&(!owned.environmentId||owned.environmentId===scope.environmentId);}):[];
    return [...new Set([...grants,...delegated].flatMap(row => parseCapabilities(JSON.parse(String(row.capabilities)))))];
  }
  authorize(identity: CreatorIdentity | null, scopeInput: ExpansionScope, capability: ExpansionCapability, localOwner = false): ExpansionScope {
    const scope = this.resolve(scopeInput);
    if (!this.capabilities(identity, scope, localOwner).includes(capability)) throw new HttpError(identity || localOwner ? 403 : 401, "PERMISSION", "이 작업을 수행할 권한이 없습니다.");
    return scope;
  }
  organization(identity: CreatorIdentity | null, id: string, capability: "org.manage" | "team.manage" | "workspace.manage" | "billing.manage" | "connection.manage" | "asset.manage" | "secret.rotate", localOwner = false): void {
    if (!one(this.db, "SELECT id FROM expansion_organizations WHERE id=?", id)) throw new HttpError(404, "ORGANIZATION_NOT_FOUND", "조직을 찾을 수 없습니다.");
    if (localOwner && this.mode === "local") return;
    const role = identity ? this.role(identity.id, id) : null;
    if (role === "owner" || (role === "admin" && !["org.manage", "billing.manage", "secret.rotate"].includes(capability)) || (role === "billing" && capability === "billing.manage")) return;
    throw new HttpError(identity ? 403 : 401, "PERMISSION", "조직 관리 권한이 없습니다.");
  }
  readable(identity: CreatorIdentity | null, organizationId: string, localOwner: boolean): boolean { return (localOwner && this.mode === "local") || Boolean(identity && this.role(identity.id, organizationId)); }
  workspace(identity: CreatorIdentity | null, id: string, capability: ExpansionCapability, localOwner = false): { organizationId: string; workspaceId: string } {
    const row = one(this.db, "SELECT * FROM expansion_workspaces WHERE id=? AND archived=0", id);
    if (!row) throw new HttpError(404, "WORKSPACE_NOT_FOUND", "작업공간을 찾을 수 없습니다.");
    const scope = { organizationId: String(row.organization_id), workspaceId: id, projectId: "" };
    if (!this.capabilities(identity, scope, localOwner).includes(capability)) throw new HttpError(identity || localOwner ? 403 : 401, "PERMISSION", "작업공간 권한이 없습니다.");
    return scope;
  }
  accessible(identity: CreatorIdentity | null, localOwner = false): string[] {
    return many(this.db, "SELECT project_id FROM expansion_project_scopes ORDER BY project_id").map(row => String(row.project_id)).filter(id => this.capabilities(identity, this.project(id), localOwner).includes("project.read"));
  }
}
