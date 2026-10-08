import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CreatorIdentity, ExpansionEnvironment, ExpansionMember, ExpansionScope, ExpansionSite, ExpansionWorkspace, Organization, OrganizationRole } from "../../src/domain/expansion";
import { record } from "../../src/domain/validation";
import type { Project } from "../../src/domain/types";
import { HttpError } from "../http";
import { email } from "../platform/auth";
import { audit, boolean, hash, integer, many, now, one, text, transaction, type SqlRow } from "../platform/common";
import { ExpansionAccess, parseCapabilities } from "./access";

export function safeConfig(value: unknown): Record<string, unknown> {
  const config = record(value ?? {});
  if (JSON.stringify(config).length > 64000) throw new HttpError(400, "CONFIG", "설정 크기를 확인하세요.");
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6) throw new HttpError(400, "CONFIG", "설정 깊이가 너무 큽니다.");
    if (node && typeof node === "object") for (const [key, child] of Object.entries(node)) {
      if (["__proto__", "prototype", "constructor"].includes(key) || /^(?:password|token|secret|apiKey|privateKey)$/i.test(key)) throw new HttpError(400, "CONFIG_SECRET", "설정에는 비밀값 대신 연결 참조를 사용하세요.");
      visit(child, depth + 1);
    }
  }; visit(config, 0); return config;
}
export const workspaceDto = (row: SqlRow): ExpansionWorkspace => ({ id: String(row.id), organizationId: String(row.organization_id), name: String(row.name), archived: Boolean(row.archived), config: JSON.parse(String(row.config)) as Record<string, unknown>, updatedAt: String(row.updated_at) });
export const siteDto = (row: SqlRow): ExpansionSite => ({ id: String(row.id), organizationId: String(row.organization_id), workspaceId: String(row.workspace_id), projectId: String(row.project_id), name: String(row.name), mode: String(row.mode) as ExpansionSite["mode"], archived: Boolean(row.archived), config: JSON.parse(String(row.config)) as Record<string, unknown>, updatedAt: String(row.updated_at) });
export const environmentDto = (row: SqlRow): ExpansionEnvironment => ({ id: String(row.id), organizationId: String(row.organization_id), workspaceId: String(row.workspace_id), projectId: String(row.project_id), siteId: String(row.site_id), name: String(row.name), kind: String(row.kind) as ExpansionEnvironment["kind"], dataKey: String(row.data_key), configVersion: Number(row.config_version), config: JSON.parse(String(row.config)) as Record<string, unknown>, updatedAt: String(row.updated_at) });

export class OrganizationService {
  constructor(readonly db: DatabaseSync, readonly access: ExpansionAccess) {}
  organizations(identity: CreatorIdentity | null, local: boolean): Organization[] {
    return many(this.db,"SELECT o.*,m.role FROM expansion_organizations o LEFT JOIN expansion_memberships m ON m.organization_id=o.id AND m.account_id=? WHERE ?=1 OR m.account_id IS NOT NULL ORDER BY o.created_at,o.id LIMIT 1000",identity?.id??'',local&&this.access.mode==='local'?1:0).map(row=>({id:String(row.id),name:String(row.name),createdAt:String(row.created_at),role:row.role?String(row.role) as OrganizationRole:local?'owner':null}));
  }
  createOrganization(identity: CreatorIdentity | null, local: boolean, input: Record<string, unknown>): Organization {
    if (!identity && !(local && this.access.mode === "local")) throw new HttpError(401, "LOGIN_REQUIRED", "제작자 로그인이 필요합니다.");
    const id = randomUUID(), name = text(input.name, "조직 이름", 100), createdAt = now();
    transaction(this.db, () => { this.db.prepare("INSERT INTO expansion_organizations VALUES(?,?,?)").run(id, name, createdAt); if (identity) this.db.prepare("INSERT INTO expansion_memberships VALUES(?,?,'owner')").run(id, identity.id); audit(this.db, "organization.create", id); });
    return { id, name, createdAt, role: "owner" };
  }
  updateOrganization(identity: CreatorIdentity | null, local: boolean, id: string, input: Record<string, unknown>): void { this.access.organization(identity, id, "org.manage", local); this.db.prepare("UPDATE expansion_organizations SET name=? WHERE id=?").run(text(input.name, "조직 이름", 100), id); audit(this.db, "organization.update", id); }
  workspaces(identity: CreatorIdentity | null, local: boolean, organizationId?: string): ExpansionWorkspace[] {
    return many(this.db,"SELECT w.* FROM expansion_workspaces w WHERE (? IS NULL OR w.organization_id=?) AND (?=1 OR EXISTS(SELECT 1 FROM expansion_memberships m WHERE m.organization_id=w.organization_id AND m.account_id=? AND (m.role<>'member' OR EXISTS(SELECT 1 FROM expansion_workspace_grants g WHERE g.workspace_id=w.id AND g.account_id=m.account_id) OR EXISTS(SELECT 1 FROM expansion_project_grants g JOIN expansion_project_scopes p ON p.project_id=g.project_id WHERE p.workspace_id=w.id AND g.account_id=m.account_id)))) ORDER BY w.updated_at DESC,w.id LIMIT 1000",organizationId??null,organizationId??null,local&&this.access.mode==='local'?1:0,identity?.id??'').map(workspaceDto);
  }
  createWorkspace(identity: CreatorIdentity | null, local: boolean, input: Record<string, unknown>): ExpansionWorkspace {
    const organizationId = text(input.organizationId, "조직 ID", 100); this.access.organization(identity, organizationId, "workspace.manage", local);
    const id = randomUUID(); this.db.prepare("INSERT INTO expansion_workspaces VALUES(?,?,?,0,?,?)").run(id, organizationId, text(input.name, "작업공간 이름", 100), JSON.stringify(safeConfig(input.config)), now()); return workspaceDto(one(this.db, "SELECT * FROM expansion_workspaces WHERE id=?", id)!);
  }
  updateWorkspace(identity: CreatorIdentity | null, local: boolean, id: string, input: Record<string, unknown>): ExpansionWorkspace {
    const previous = one(this.db, "SELECT * FROM expansion_workspaces WHERE id=?", id); if (!previous) throw new HttpError(404, "WORKSPACE_NOT_FOUND", "작업공간을 찾을 수 없습니다.");
    this.access.organization(identity, String(previous.organization_id), "workspace.manage", local);
    this.db.prepare("UPDATE expansion_workspaces SET name=?,archived=?,config=?,updated_at=? WHERE id=?").run(input.name === undefined ? String(previous.name) : text(input.name, "이름", 100), boolean(input.archived, "보관", Boolean(previous.archived)) ? 1 : 0, JSON.stringify(input.config === undefined ? JSON.parse(String(previous.config)) : safeConfig(input.config)), now(), id);
    return workspaceDto(one(this.db, "SELECT * FROM expansion_workspaces WHERE id=?", id)!);
  }
  registerProject(project: Project, workspaceId: string, identity: CreatorIdentity | null, local: boolean): ExpansionScope {
    const workspace = this.access.workspace(identity, workspaceId, "project.create", local), existing = one(this.db, "SELECT * FROM expansion_project_scopes WHERE project_id=?", project.id);
    if (existing) { if (existing.workspace_id !== workspaceId) throw new HttpError(409, "PROJECT_SCOPE", "기존 프로젝트를 다른 작업공간에 자동 연결할 수 없습니다."); return this.access.project(project.id); }
    if (!one(this.db, "SELECT id FROM projects WHERE id=?", project.id)) throw new HttpError(404, "PROJECT_NOT_FOUND", "먼저 프로젝트 문서를 저장하세요.");
    transaction(this.db, () => {
      this.db.prepare("INSERT INTO expansion_project_scopes VALUES(?,?,?)").run(project.id, workspace.organizationId, workspaceId);
      this.db.prepare("INSERT INTO expansion_sites VALUES(?,?,?,?,?,?,0,'{}',?)").run(project.id, workspace.organizationId, workspaceId, project.id, project.name, this.access.mode, now());
      this.db.prepare("INSERT INTO expansion_environments VALUES(?,?,?,?,?,?,'production',?,1,'{}',?)").run(project.id + "-production", project.id, workspace.organizationId, workspaceId, project.id, "운영", project.id, now());
    }); return this.access.project(project.id);
  }
  private readableProjectSql(alias:string,environment?:string):string {return `EXISTS(SELECT 1 FROM expansion_memberships m WHERE m.organization_id=${alias}.organization_id AND m.account_id=? AND (m.role IN('owner','admin') OR (m.role='member' AND (EXISTS(SELECT 1 FROM expansion_workspace_grants g,json_each(g.capabilities) c WHERE g.workspace_id=${alias}.workspace_id AND g.account_id=m.account_id AND c.value='project.read') OR EXISTS(SELECT 1 FROM expansion_project_grants g,json_each(g.capabilities) c WHERE g.project_id=${alias}.project_id AND g.account_id=m.account_id AND c.value='project.read') OR EXISTS(SELECT 1 FROM advancement_support_sessions s JOIN expansion_memberships a ON a.account_id=s.approved_by AND a.organization_id=m.organization_id,json_each(s.capabilities) c WHERE s.support_id=m.account_id AND s.revoked=0 AND s.expires_at>${Date.now()} AND a.role IN('owner','admin') AND json_extract(s.scope,'$.projectId')=${alias}.project_id ${environment?`AND (json_extract(s.scope,'$.environmentId') IS NULL OR json_extract(s.scope,'$.environmentId')=${environment})`:''} AND c.value='project.read')))))`;}
  sites(identity: CreatorIdentity | null, local: boolean, workspaceId?: string): ExpansionSite[] { return many(this.db,`SELECT s.* FROM expansion_sites s WHERE (? IS NULL OR s.workspace_id=?) AND (?=1 OR ${this.readableProjectSql('s')}) ORDER BY s.updated_at DESC,s.id LIMIT 1000`,workspaceId??null,workspaceId??null,local&&this.access.mode==='local'?1:0,identity?.id??'').map(siteDto); }
  createSite(identity: CreatorIdentity | null, local: boolean, input: Record<string, unknown>): ExpansionSite {
    const scope = this.access.project(text(input.projectId, "프로젝트 ID", 100)); this.access.authorize(identity, scope, "project.edit", local);
    if (input.workspaceId !== scope.workspaceId) throw new HttpError(403, "SCOPE_MISMATCH", "작업공간 소유 범위를 확인하세요.");
    const mode = input.mode ?? this.access.mode; if (!["local", "managed", "selfhost"].includes(String(mode))) throw new HttpError(400, "SITE_MODE", "실행 모드를 확인하세요.");
    const id = randomUUID(); this.db.prepare("INSERT INTO expansion_sites VALUES(?,?,?,?,?,?,0,?,?)").run(id, scope.organizationId, scope.workspaceId, scope.projectId, text(input.name, "사이트 이름", 100), String(mode), JSON.stringify(safeConfig(input.config)), now());
    return siteDto(one(this.db, "SELECT * FROM expansion_sites WHERE id=?", id)!);
  }
  updateSite(identity: CreatorIdentity | null, local: boolean, id: string, input: Record<string, unknown>): ExpansionSite {
    const previous = one(this.db, "SELECT * FROM expansion_sites WHERE id=?", id); if (!previous) throw new HttpError(404, "SITE_NOT_FOUND", "사이트를 찾을 수 없습니다.");
    this.access.authorize(identity, this.access.project(String(previous.project_id)), "project.edit", local);
    const mode = input.mode ?? previous.mode; if (!["local", "managed", "selfhost"].includes(String(mode))) throw new HttpError(400, "SITE_MODE", "실행 모드를 확인하세요.");
    this.db.prepare("UPDATE expansion_sites SET name=?,mode=?,archived=?,config=?,updated_at=? WHERE id=?").run(input.name === undefined ? String(previous.name) : text(input.name, "이름", 100), String(mode), boolean(input.archived, "보관", Boolean(previous.archived)) ? 1 : 0, JSON.stringify(input.config === undefined ? JSON.parse(String(previous.config)) : safeConfig(input.config)), now(), id); return siteDto(one(this.db, "SELECT * FROM expansion_sites WHERE id=?", id)!);
  }
  environments(identity: CreatorIdentity | null, local: boolean, siteId?: string): ExpansionEnvironment[] { return many(this.db,`SELECT e.* FROM expansion_environments e WHERE (? IS NULL OR e.site_id=?) AND (?=1 OR ${this.readableProjectSql('e','e.id')}) ORDER BY e.updated_at DESC,e.id LIMIT 1000`,siteId??null,siteId??null,local&&this.access.mode==='local'?1:0,identity?.id??'').map(environmentDto); }
  createEnvironment(identity: CreatorIdentity | null, local: boolean, input: Record<string, unknown>): ExpansionEnvironment {
    const site = one(this.db, "SELECT * FROM expansion_sites WHERE id=? AND archived=0", text(input.siteId, "사이트 ID", 100)); if (!site) throw new HttpError(404, "SITE_NOT_FOUND", "사이트를 찾을 수 없습니다.");
    const scope = this.access.project(String(site.project_id)); this.access.authorize(identity, scope, "project.publish", local);
    if (!["development", "staging", "production"].includes(String(input.kind))) throw new HttpError(400, "ENVIRONMENT_KIND", "환경 종류를 확인하세요.");
    const id = randomUUID(); this.db.prepare("INSERT INTO expansion_environments VALUES(?,?,?,?,?,?,?,?,1,?,?)").run(id, String(site.id), scope.organizationId, scope.workspaceId, scope.projectId, text(input.name, "환경 이름", 100), String(input.kind), "env-" + id, JSON.stringify(safeConfig(input.config)), now()); return environmentDto(one(this.db, "SELECT * FROM expansion_environments WHERE id=?", id)!);
  }
  updateEnvironment(identity: CreatorIdentity | null, local: boolean, id: string, input: Record<string, unknown>): ExpansionEnvironment {
    this.access.authorize(identity, this.access.environment(id), "project.publish", local);
    const previous = one(this.db, "SELECT * FROM expansion_environments WHERE id=?", id)!;
    const version = integer(input.baseVersion, "설정 버전", 1);
    const changed = this.db.prepare("UPDATE expansion_environments SET name=?,config=?,config_version=config_version+1,updated_at=? WHERE id=? AND config_version=?").run(input.name === undefined ? String(previous.name) : text(input.name, "이름", 100), JSON.stringify(safeConfig(input.config)), now(), id, version);
    if (!changed.changes) throw new HttpError(409, "ENVIRONMENT_CONFLICT", "환경 설정이 변경되었습니다. 최신본을 확인하세요.");
    return environmentDto(one(this.db, "SELECT * FROM expansion_environments WHERE id=?", id)!);
  }
  members(identity: CreatorIdentity | null, local: boolean, organizationId: string): ExpansionMember[] {
    this.access.organization(identity, organizationId, "team.manage", local);
    return many(this.db, "SELECT a.id,a.email,a.display_name,m.role FROM expansion_memberships m JOIN creator_accounts a ON a.id=m.account_id WHERE m.organization_id=? ORDER BY a.display_name LIMIT 1000", organizationId).map(row => ({ account: { id: String(row.id), email: String(row.email), displayName: String(row.display_name) }, role: String(row.role) as OrganizationRole, workspaceGrants: many(this.db, "SELECT g.* FROM expansion_workspace_grants g JOIN expansion_workspaces w ON w.id=g.workspace_id WHERE w.organization_id=? AND g.account_id=?", organizationId, String(row.id)).map(grant => ({ workspaceId: String(grant.workspace_id), capabilities: parseCapabilities(JSON.parse(String(grant.capabilities))) })), projectGrants: many(this.db, "SELECT g.* FROM expansion_project_grants g JOIN expansion_project_scopes p ON p.project_id=g.project_id WHERE p.organization_id=? AND g.account_id=?", organizationId, String(row.id)).map(grant => ({ projectId: String(grant.project_id), capabilities: parseCapabilities(JSON.parse(String(grant.capabilities))) })) }));
  }
  changeMember(identity: CreatorIdentity | null, local: boolean, id: string, input: Record<string, unknown>, remove = false): void {
    const organizationId = text(input.organizationId, "조직 ID", 100); this.access.organization(identity, organizationId, "team.manage", local);
    const previous = one(this.db, "SELECT role FROM expansion_memberships WHERE organization_id=? AND account_id=?", organizationId, id); if (!previous) throw new HttpError(404, "MEMBER_NOT_FOUND", "멤버를 찾을 수 없습니다.");
    const role = input.role ?? previous.role; if (!["owner", "admin", "billing", "member"].includes(String(role))) throw new HttpError(400, "ROLE", "역할을 확인하세요.");
    const isOwner = local && this.access.mode === "local" || identity && this.access.role(identity.id, organizationId) === "owner";
    if (!isOwner && (role === "owner" || previous.role === "owner")) throw new HttpError(403, "OWNER_REQUIRED", "조직 소유자만 소유권을 변경할 수 있습니다.");
    transaction(this.db, () => {
      if (previous.role === "owner" && (remove || role !== "owner") && Number(one(this.db, "SELECT COUNT(*) AS count FROM expansion_memberships WHERE organization_id=? AND role='owner'", organizationId)?.count) < 2) throw new HttpError(409, "LAST_OWNER", "마지막 소유자를 제거할 수 없습니다. 먼저 인계하세요.");
      for (const kind of ["workspace", "project"] as const) {
        const values = input[kind + "Grants"];
        if (values !== undefined && (!Array.isArray(values) || values.length > 1000)) throw new HttpError(400, "GRANTS", "권한 범위를 확인하세요.");
        if (remove || values !== undefined) this.db.prepare(`DELETE FROM expansion_${kind}_grants WHERE account_id=? AND ${kind}_id IN(SELECT ${kind === "workspace" ? "id" : "project_id"} FROM expansion_${kind === "workspace" ? "workspaces" : "project_scopes"} WHERE organization_id=?)`).run(id, organizationId);
        if (!remove && Array.isArray(values)) for (const item of values) {
          const grant = record(item), resource = text(grant[kind + "Id"], "리소스 ID", 100), capabilities = parseCapabilities(grant.capabilities);
          const owned = one(this.db, `SELECT organization_id FROM expansion_${kind === "workspace" ? "workspaces WHERE id" : "project_scopes WHERE project_id"}=?`, resource);
          if (owned?.organization_id !== organizationId) throw new HttpError(403, "SCOPE_MISMATCH", "권한을 부여할 리소스가 다른 조직에 있습니다.");
          if (!isOwner && capabilities.some(capability => ["org.manage", "secret.rotate", "billing.manage"].includes(capability))) throw new HttpError(403, "GRANT_ESCALATION", "보유 범위를 넘는 권한을 부여할 수 없습니다.");
          this.db.prepare(`INSERT INTO expansion_${kind}_grants VALUES(?,?,?)`).run(resource, id, JSON.stringify(capabilities));
        }
      }
      if (remove) this.db.prepare("DELETE FROM expansion_memberships WHERE organization_id=? AND account_id=?").run(organizationId, id); else this.db.prepare("UPDATE expansion_memberships SET role=? WHERE organization_id=? AND account_id=?").run(String(role), organizationId, id);
      audit(this.db, remove ? "organization.member.remove" : "organization.member.update", id);
    });
  }
  invite(identity: CreatorIdentity | null, local: boolean, input: Record<string, unknown>): { id: string; token: string; expiresAt: string } {
    const organizationId = text(input.organizationId, "조직 ID", 100); this.access.organization(identity, organizationId, "team.manage", local);
    const role = input.role ?? "member"; if (!["admin", "billing", "member"].includes(String(role))) throw new HttpError(400, "ROLE", "초대 역할을 확인하세요.");
    if (role === "billing") this.access.organization(identity, organizationId, "billing.manage", local);
    const workspace = input.workspaceId ? text(input.workspaceId, "작업공간", 100) : null, capabilities = parseCapabilities(input.capabilities ?? []);
    if (workspace && one(this.db, "SELECT organization_id FROM expansion_workspaces WHERE id=?", workspace)?.organization_id !== organizationId) throw new HttpError(403, "SCOPE_MISMATCH", "작업공간을 확인하세요.");
    if (!(local && this.access.mode === "local" || identity && this.access.role(identity.id, organizationId) === "owner") && capabilities.some(value => ["org.manage", "secret.rotate", "billing.manage"].includes(value))) throw new HttpError(403, "GRANT_ESCALATION", "보유 범위를 넘는 권한을 초대할 수 없습니다.");
    const id = randomUUID(), token = randomBytes(32).toString("hex"), expires = Date.now() + 86400_000;
    this.db.prepare("INSERT INTO expansion_invites VALUES(?,?,?,?,?,?,?,?, 'pending',?)").run(id, organizationId, email(input.email), String(role), workspace, JSON.stringify(capabilities), hash(token), expires, now()); audit(this.db, "organization.invite", id); return { id, token, expiresAt: new Date(expires).toISOString() };
  }
  accept(identity: CreatorIdentity | null, token: unknown): void {
    if (!identity) throw new HttpError(401, "LOGIN_REQUIRED", "초대받은 제작자 계정으로 로그인하세요.");
    transaction(this.db, () => {
      const invite = one(this.db, "SELECT * FROM expansion_invites WHERE token_hash=? AND status='pending' AND expires_at>?", hash(text(token, "초대 토큰", 100)), Date.now()), current = one(this.db, "SELECT email FROM creator_accounts WHERE id=? AND disabled=0", identity.id);
      if (!invite || invite.email !== current?.email) throw new HttpError(400, "INVITE", "사용할 수 없는 초대입니다.");
      this.db.prepare("INSERT INTO expansion_memberships VALUES(?,?,?) ON CONFLICT DO NOTHING").run(String(invite.organization_id), identity.id, String(invite.role));
      if (invite.workspace_id) this.db.prepare("INSERT INTO expansion_workspace_grants VALUES(?,?,?) ON CONFLICT DO NOTHING").run(String(invite.workspace_id), identity.id, String(invite.capabilities));
      this.db.prepare("UPDATE expansion_invites SET status='accepted' WHERE id=?").run(String(invite.id)); audit(this.db, "organization.invite.accept", String(invite.id));
    });
  }
  revoke(identity: CreatorIdentity | null, local: boolean, id: string): void { const invite = one(this.db, "SELECT organization_id FROM expansion_invites WHERE id=?", id); if (!invite) throw new HttpError(404, "INVITE", "초대를 찾을 수 없습니다."); this.access.organization(identity, String(invite.organization_id), "team.manage", local); this.db.prepare("UPDATE expansion_invites SET status='revoked' WHERE id=? AND status='pending'").run(id); }
  transfer(identity: CreatorIdentity | null, local: boolean, organizationId: string, target: string): void {
    this.access.organization(identity, organizationId, "org.manage", local);
    transaction(this.db, () => {
      if (!one(this.db, "SELECT 1 FROM expansion_memberships m JOIN creator_accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.account_id=? AND a.disabled=0", organizationId, target)) throw new HttpError(400, "TRANSFER_MEMBER", "활성 조직 멤버에게 인계하세요.");
      this.db.prepare("UPDATE expansion_memberships SET role='owner' WHERE organization_id=? AND account_id=?").run(organizationId, target);
      if (identity && identity.id !== target) this.db.prepare("UPDATE expansion_memberships SET role='admin' WHERE organization_id=? AND account_id=?").run(organizationId, identity.id);
      audit(this.db, "organization.transfer", organizationId);
    });
  }
}
