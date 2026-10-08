import { randomUUID } from "node:crypto";
import { encryptSecret, decryptSecret, configuredKeys, activeKeyId } from "../advancement/keyring";
import type { DatabaseSync } from "node:sqlite";
import type { ExpansionScope } from "../../src/domain/expansion";
import { HttpError } from "../http";
import { many, now, one, text, transaction, type SqlRow } from "../platform/common";

export class SecretService {
  constructor(readonly db: DatabaseSync) {}
  encrypt(value: string): string { return encryptSecret(value); }
  decrypt(value: string): string { return decryptSecret(value); }
  private audit(secretId: string, organizationId: string, actor: string, operation: string): void { this.db.prepare("INSERT INTO expansion_secret_audit VALUES(?,?,?,?,?,?,?)").run(randomUUID(), secretId, organizationId, actor, operation, "success", now()); }
  list(organizationId: string): SqlRow[] { return many(this.db, "SELECT id,organization_id AS organizationId,workspace_id AS workspaceId,name,version,disabled,updated_at AS updatedAt FROM expansion_secrets WHERE organization_id=? ORDER BY name LIMIT 500", organizationId).map(row => ({ ...row, disabled: Boolean(row.disabled), configured: configuredKeys().has(activeKeyId()) })); }
  save(organizationId: string, actor: string, input: Record<string, unknown>, id?: string): SqlRow {
    const name = text(input.name, "비밀 참조 이름", 80); if (!/^TENANT_[A-Z0-9_]{1,72}$/.test(name)) throw new HttpError(400, "SECRET_NAME", "조직 비밀 참조는 TENANT_로 시작해야 합니다.");
    const workspaceId = input.workspaceId ? text(input.workspaceId, "작업공간", 100) : null;
    if (workspaceId && one(this.db, "SELECT organization_id FROM expansion_workspaces WHERE id=?", workspaceId)?.organization_id !== organizationId) throw new HttpError(403, "SECRET_SCOPE", "비밀 작업공간 소유 범위를 확인하세요.");
    const value = text(input.value, "비밀값", 16000), key = id ?? randomUUID(), encrypted = this.encrypt(value);
    transaction(this.db, () => {
      const previous = one(this.db, "SELECT * FROM expansion_secrets WHERE id=? AND organization_id=?", key, organizationId);
      if (id && !previous) throw new HttpError(404, "SECRET", "비밀 참조를 찾을 수 없습니다.");
      if (previous && Number(input.baseVersion) !== Number(previous.version)) throw new HttpError(409, "SECRET_CONFLICT", "비밀 버전이 변경되었습니다.");
      this.db.prepare("INSERT INTO expansion_secrets VALUES(?,?,?,?,?,1,0,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,workspace_id=excluded.workspace_id,ciphertext=excluded.ciphertext,version=version+1,disabled=0,updated_at=excluded.updated_at").run(key, organizationId, workspaceId, name, encrypted, now()); this.audit(key, organizationId, actor, id ? "rotate" : "create");
    }); return this.list(organizationId).find(row => row.id === key)!;
  }
  disable(organizationId: string, id: string, actor: string): void { transaction(this.db, () => { const changed = this.db.prepare("UPDATE expansion_secrets SET disabled=1,version=version+1,updated_at=? WHERE id=? AND organization_id=?").run(now(), id, organizationId); if (!changed.changes) throw new HttpError(404, "SECRET", "비밀 참조를 찾을 수 없습니다."); this.audit(id, organizationId, actor, "disable"); }); }
  registered(scope:ExpansionScope,reference:string):boolean {return Boolean(scope.environmentId&&one(this.db,"SELECT name FROM sqlite_master WHERE name='advancement_secret_versions'")&&one(this.db,'SELECT 1 FROM advancement_secret_versions WHERE environment_id=? AND name=? AND organization_id=? AND workspace_id=? AND project_id=?',scope.environmentId,reference,scope.organizationId,scope.workspaceId,scope.projectId));}
  resolve(scope: ExpansionScope, reference: string, actor = "runtime"): string | undefined {
    if (!/^TENANT_[A-Z0-9_]{1,72}$/.test(reference)) return undefined;
    if (scope.environmentId && one(this.db, "SELECT name FROM sqlite_master WHERE name='advancement_secret_versions'")) {
      const scoped = one(this.db, "SELECT * FROM advancement_secret_versions WHERE environment_id=? AND name=? AND organization_id=? AND workspace_id=? AND project_id=? ORDER BY version DESC LIMIT 1", scope.environmentId, reference, scope.organizationId, scope.workspaceId, scope.projectId);
      if (scoped) { const active=one(this.db,"SELECT ciphertext FROM advancement_secret_versions WHERE environment_id=? AND name=? AND status='active'",scope.environmentId,reference); return active?this.decrypt(String(active.ciphertext)):undefined; }
    }
    const row = one(this.db, "SELECT * FROM expansion_secrets WHERE organization_id=? AND name=? AND disabled=0 AND (workspace_id IS NULL OR workspace_id=?)", scope.organizationId, reference, scope.workspaceId);
    if (!row) return undefined;
    const result = this.decrypt(String(row.ciphertext)); this.audit(String(row.id), scope.organizationId, actor, "use"); return result;
  }
  auditEntries(organizationId: string): SqlRow[] { return many(this.db, "SELECT id,secret_id AS secretId,actor_id AS actorId,operation,status,created_at AS createdAt FROM expansion_secret_audit WHERE organization_id=? ORDER BY created_at DESC LIMIT 200", organizationId); }
}
