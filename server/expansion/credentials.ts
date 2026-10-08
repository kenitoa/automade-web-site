import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { ApiCredential, CreatorIdentity, ExpansionCapability, ExpansionScope } from "../../src/domain/expansion";
import { HttpError } from "../http";
import { audit, hash, many, now, one, text, transaction, type SqlRow } from "../platform/common";
import { verifyWebhook } from "../platform/business";
import { ExpansionAccess, parseCapabilities } from "./access";
import { SecretService } from "./secrets";
import { IdentityService } from "../advancement/identities";

export class CredentialService {
  constructor(readonly db: DatabaseSync, readonly access: ExpansionAccess, readonly secrets: SecretService) {}
  private dto(row: SqlRow): ApiCredential { return { id: String(row.id), name: String(row.name), scope: row.environment_id ? this.access.environment(String(row.environment_id)) : this.access.project(String(row.project_id)), capabilities: parseCapabilities(JSON.parse(String(row.capabilities))), expiresAt: new Date(Number(row.expires_at)).toISOString(), revoked: Boolean(row.revoked), createdAt: String(row.created_at) }; }
  list(scope: ExpansionScope): ApiCredential[] { return many(this.db, "SELECT * FROM expansion_credentials WHERE organization_id=? AND project_id=? ORDER BY created_at DESC LIMIT 200", scope.organizationId, scope.projectId).map(row => this.dto(row)); }
  issue(scope: ExpansionScope, identity: CreatorIdentity | null, local: boolean, input: Record<string, unknown>): ApiCredential & { token: string; webhookSecret: string } {
    const capabilities = parseCapabilities(input.capabilities), available = this.access.capabilities(identity, scope, local);
    if (!capabilities.length || capabilities.some(value => !available.includes(value) || ["org.manage", "team.manage", "secret.rotate", "billing.manage", "workspace.manage", "backup.restore"].includes(value))) throw new HttpError(403, "CREDENTIAL_CAPABILITY", "현재 리소스의 보유 범위 안에서 API 권한을 발급하세요.");
    const expires = typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : Date.now() + 86400_000;
    if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 90 * 86400_000) throw new HttpError(400, "CREDENTIAL_EXPIRY", "API 키 만료는 90일 이내로 지정하세요.");
    const id = randomUUID(), token = randomBytes(32).toString("hex"), webhookSecret = randomBytes(32).toString("hex");
    const encrypted = this.secrets.encrypt(webhookSecret);
    this.db.prepare("INSERT INTO expansion_credentials(id,name,organization_id,workspace_id,project_id,environment_id,token_hash,capabilities,expires_at,revoked,created_at,issuer_id,webhook_secret) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?)").run(id, text(input.name, "API 키 이름", 100), scope.organizationId, scope.workspaceId, scope.projectId, scope.environmentId ?? null, hash(token), JSON.stringify(capabilities), expires, now(), identity?.id ?? null, encrypted); audit(this.db, "api.credential.issue", id);
    return { ...this.dto(one(this.db, "SELECT * FROM expansion_credentials WHERE id=?", id)!), token, webhookSecret };
  }
  revoke(scope: ExpansionScope, id: string): void { const change = this.db.prepare("UPDATE expansion_credentials SET revoked=1 WHERE id=? AND organization_id=? AND project_id=?").run(id, scope.organizationId, scope.projectId); if (!change.changes) throw new HttpError(404, "CREDENTIAL", "API 키를 찾을 수 없습니다."); audit(this.db, "api.credential.revoke", id); }
  private check(row: SqlRow, capability: ExpansionCapability): { credential: ApiCredential; identity: CreatorIdentity | null; actorId: string } {
    if (row.revoked || Number(row.expires_at) <= Date.now()) throw new HttpError(401, "API_CREDENTIAL", "API 키가 만료되었거나 폐기되었습니다.");
    const credential = this.dto(row); if (!credential.capabilities.includes(capability)) throw new HttpError(403, "API_PERMISSION", "API 키 범위에 없는 작업입니다.");
    const issuer = row.issuer_id ? one(this.db, "SELECT id FROM creator_accounts WHERE id=? AND disabled=0", String(row.issuer_id)) : null;
    const identity = issuer ? { id: String(issuer.id), csrf: "", sessionId: "" } : null;
    if (row.issuer_id && !identity || !row.issuer_id && this.access.mode !== "local") throw new HttpError(403, "API_ISSUER", "발급자 권한이 회수되었습니다.");
    this.access.authorize(identity, credential.scope, capability, !row.issuer_id && this.access.mode === "local");
    return { credential, identity, actorId: identity?.id ?? "local-owner" };
  }
  authenticate(req: IncomingMessage, capability: ExpansionCapability): ReturnType<CredentialService["check"]> {
    const authorization = String(req.headers.authorization ?? ""), token = authorization.match(/^Bearer ([a-f0-9]{64})$/)?.[1], row = token ? one(this.db, "SELECT * FROM expansion_credentials WHERE token_hash=?", hash(token)) : null;
    if (!row && token && one(this.db,"SELECT name FROM sqlite_master WHERE name='advancement_service_identities'")) { const service=new IdentityService(this.db,this.access).authenticate(token,capability);if(service){const {identity,actorId,...credential}=service;return {credential,identity,actorId};} }
    if (!row) throw new HttpError(401, "API_CREDENTIAL", "범위가 지정된 API 키가 필요합니다."); return this.check(row, capability);
  }
  webhook(credentialId: string, timestamp: string, raw: string, signature: string): ReturnType<CredentialService["check"]> {
    const row = one(this.db, "SELECT * FROM expansion_credentials WHERE id=?", credentialId);
    if (!row || !row.webhook_secret) throw new HttpError(401, "WEBHOOK_CREDENTIAL", "웹훅 인증을 확인하세요.");
    const result = this.check(row, "automation.manage"); verifyWebhook(this.secrets.decrypt(String(row.webhook_secret)), timestamp, raw, signature); return result;
  }
  claimEvent(id: string, eventId: string, payload: unknown): { id: string; completed: boolean } {
    const fingerprint = hash(JSON.stringify(payload)); return transaction(this.db, () => {
      const old = one(this.db, "SELECT * FROM expansion_webhook_events WHERE credential_id=? AND event_id=?", id, eventId);
      if (old) { if (old.fingerprint !== fingerprint) throw new HttpError(409, "WEBHOOK_REPLAY", "동일 이벤트 식별자의 내용이 다릅니다."); return { id: String(old.id), completed: old.status === "completed" }; }
      const key = randomUUID(); this.db.prepare("INSERT INTO expansion_webhook_events VALUES(?,?,?,?,'pending',?)").run(key, id, eventId, fingerprint, now()); return { id: key, completed: false };
    });
  }
  completeEvent(id: string): void { this.db.prepare("UPDATE expansion_webhook_events SET status='completed' WHERE id=?").run(id); }
}
