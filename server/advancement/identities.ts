import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CreatorIdentity,
  ExpansionCapability,
  ExpansionScope,
} from "../../src/domain/expansion";
import type { ServiceIdentity } from "../../src/domain/advancement";
import { HttpError } from "../http";
import { hash, many, now, one, text, transaction } from "../platform/common";
import { ExpansionAccess, parseCapabilities } from "../expansion/access";
export class IdentityService {
  constructor(
    readonly db: DatabaseSync,
    readonly access: ExpansionAccess,
  ) {}
  private dto(row: Record<string, unknown>): ServiceIdentity {
    return {
      id: String(row.id),
      name: String(row.name),
      scope: JSON.parse(String(row.scope)),
      capabilities: parseCapabilities(JSON.parse(String(row.capabilities))),
      ownerId: String(row.owner_id),
      expiresAt: new Date(Number(row.expires_at)).toISOString(),
      revoked: Boolean(row.revoked),
      revision: Number(row.revision),
      lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    };
  }
  list(scope: ExpansionScope): ServiceIdentity[] {
    return many(
      this.db,
      "SELECT * FROM advancement_service_identities WHERE json_extract(scope,'$.organizationId')=? AND json_extract(scope,'$.projectId')=? AND COALESCE(json_extract(scope,'$.environmentId'),'')=? ORDER BY name LIMIT 200",
      scope.organizationId,
      scope.projectId,
      scope.environmentId??'',
    ).map((row) => this.dto(row));
  }
  create(
    scope: ExpansionScope,
    actor: CreatorIdentity | null,
    local: boolean,
    input: Record<string, unknown>,
  ): ServiceIdentity & { token: string; keyId: string } {
    const capabilities = parseCapabilities(input.capabilities),
      available = this.access.capabilities(actor, scope, local),
      forbidden: ExpansionCapability[] = [
        "org.manage",
        "team.manage",
        "billing.manage",
        "secret.rotate",
        "backup.restore",
        "workspace.manage",
      ];
    if (
      !capabilities.length ||
      capabilities.some(
        (cap) => !available.includes(cap) || forbidden.includes(cap),
      )
    )
      throw new HttpError(
        403,
        "SERVICE_PERMISSION",
        "조직이 승인한 업무 권한만 기계 계정에 부여하세요.",
      );
    const expiry = Date.parse(text(input.expiresAt, "만료 시각", 50));
    if (
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > Date.now() + 90 * 86400000
    )
      throw new HttpError(
        400,
        "SERVICE_EXPIRY",
        "90일 이내 만료 시각이 필요합니다.",
      );
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO advancement_service_identities VALUES(?,?,?,?,?,?,0,1,NULL)",
      )
      .run(
        id,
        text(input.name, "기계 계정 이름", 100),
        JSON.stringify(scope),
        JSON.stringify(capabilities),
        actor?.id ?? "local-owner",
        expiry,
      );
    return {
      ...this.list(scope).find((row) => row.id === id)!,
      ...this.rotate(scope, id, 0),
    };
  }
  rotate(
    scope: ExpansionScope,
    id: string,
    graceMinutes = 15,
  ): { token: string; keyId: string } {
    const row = one(
      this.db,
      "SELECT * FROM advancement_service_identities WHERE id=?",
      id,
    );
    if (
      !row ||
      JSON.parse(String(row.scope)).projectId !== scope.projectId ||
      JSON.parse(String(row.scope)).organizationId !== scope.organizationId ||
      (JSON.parse(String(row.scope)).environmentId??null)!==(scope.environmentId??null) ||
      row.revoked || Number(row.expires_at)<=Date.now()
    )
      throw new HttpError(
        404,
        "SERVICE_IDENTITY",
        "활성 기계 계정을 찾을 수 없습니다.",
      );
    if (
      !Number.isInteger(graceMinutes) ||
      graceMinutes < 0 ||
      graceMinutes > 30
    )
      throw new HttpError(400, "KEY_GRACE", "전환 시간은 0~30분입니다.");
    const token = randomBytes(32).toString("hex"),
      keyId = randomUUID();
    transaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE advancement_service_keys SET expires_at=MIN(expires_at,?) WHERE identity_id=? AND revoked=0",
        )
        .run(Date.now() + graceMinutes * 60000, id);
      this.db
        .prepare("INSERT INTO advancement_service_keys VALUES(?,?,?,?,0,?)")
        .run(keyId, id, hash(token), Number(row.expires_at), now());
      this.db
        .prepare(
          "UPDATE advancement_service_identities SET revision=revision+1 WHERE id=?",
        )
        .run(id);
    });
    return { token, keyId };
  }
  revoke(scope: ExpansionScope, id: string): void {
    const row = this.list(scope).find((item) => item.id === id);
    if (!row)
      throw new HttpError(
        404,
        "SERVICE_IDENTITY",
        "기계 계정을 찾을 수 없습니다.",
      );
    transaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE advancement_service_identities SET revoked=1,revision=revision+1 WHERE id=?",
        )
        .run(id);
      this.db
        .prepare(
          "UPDATE advancement_service_keys SET revoked=1 WHERE identity_id=?",
        )
        .run(id);
      this.db
        .prepare(
          "INSERT INTO advancement_auth_tombstones VALUES('service',?,?) ON CONFLICT DO NOTHING",
        )
        .run(id, now());
    });
  }
  authenticate(
    token: string,
    capability: ExpansionCapability,
  ): {
    id: string;
    scope: ExpansionScope;
    capabilities: ExpansionCapability[];
    expiresAt: string;
    revoked: boolean;
    createdAt: string;
    name: string;
    identity: CreatorIdentity;
    actorId: string;
  } | null {
    const row = one(
      this.db,
      "SELECT i.*,k.id AS key_id FROM advancement_service_keys k JOIN advancement_service_identities i ON i.id=k.identity_id WHERE k.token_hash=? AND k.revoked=0 AND k.expires_at>? AND i.revoked=0 AND i.expires_at>?",
      hash(token),
      Date.now(),
      Date.now(),
    );
    if (!row) return null;
    const value = this.dto(row),
      identity = {
        id: value.id,
        csrf: "",
        sessionId: "service:" + String(row.key_id),
      };
    this.access.authorize(identity, value.scope, capability);
    this.db
      .prepare(
        "UPDATE advancement_service_identities SET last_used_at=? WHERE id=?",
      )
      .run(now(), value.id);
    return {
      id: String(row.key_id),
      scope: value.scope,
      capabilities: value.capabilities,
      expiresAt: value.expiresAt,
      revoked: false,
      createdAt: now(),
      name: value.name,
      identity,
      actorId: value.id,
    };
  }
}
