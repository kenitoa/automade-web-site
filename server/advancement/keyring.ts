import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "../http";
import { integer, many, now, one, text, transaction } from "../platform/common";
export function configuredKeys(): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  if (
    process.env.EXPANSION_SECRET_KEY &&
    /^[a-fA-F0-9]{64}$/.test(process.env.EXPANSION_SECRET_KEY)
  )
    result.set("legacy", Buffer.from(process.env.EXPANSION_SECRET_KEY, "hex"));
  if (process.env.EXPANSION_SECRET_KEYS) {
    let raw: unknown;
    try {
      raw = JSON.parse(process.env.EXPANSION_SECRET_KEYS);
    } catch {
      throw new HttpError(
        503,
        "KEYRING_CONFIG",
        "서버 키 목록 형식을 확인하세요.",
      );
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new HttpError(503, "KEYRING_CONFIG", "서버 키 목록이 필요합니다.");
    for (const [id, key] of Object.entries(raw)) {
      if (
        !/^[A-Za-z0-9_-]{1,40}$/.test(id) ||
        typeof key !== "string" ||
        !/^[a-fA-F0-9]{64}$/.test(key)
      )
        throw new HttpError(
          503,
          "KEYRING_CONFIG",
          "키 식별자와 256비트 키 형식을 확인하세요.",
        );
      result.set(id, Buffer.from(key, "hex"));
    }
  }
  return result;
}
export function activeKeyId(): string {
  const id = process.env.EXPANSION_ACTIVE_KEY_ID ?? "legacy";
  if (!configuredKeys().has(id))
    throw new HttpError(
      503,
      "VAULT_UNCONFIGURED",
      "활성 암호화 키를 서버에 설정하세요.",
    );
  return id;
}
export function encryptSecret(value: string): string {
  const id = activeKeyId(),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", configuredKeys().get(id)!, iv),
    data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    id,
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    data.toString("hex"),
  ].join(":");
}
export function ciphertextKeyId(value: string): string {
  return value.startsWith("v1:") ? value.split(":")[1]! : "legacy";
}
export function decryptSecret(value: string): string {
  const parts = value.split(":"),
    id = ciphertextKeyId(value),
    [iv, tag, data] = value.startsWith("v1:") ? parts.slice(2) : parts,
    key = configuredKeys().get(id);
  if (!key)
    throw new HttpError(
      503,
      "VAULT_KEY_MISSING",
      "데이터가 사용하는 키 버전을 서버에 복구하세요.",
    );
  try {
    if (!iv || !tag || data === undefined) throw new Error("FORMAT");
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
    cipher.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([
      cipher.update(Buffer.from(data, "hex")),
      cipher.final(),
    ]).toString("utf8");
  } catch {
    throw new HttpError(
      503,
      "VAULT_INTEGRITY",
      "암호화 저장소 무결성을 확인하세요.",
    );
  }
}
export function rotateKeyBatch(
  db: DatabaseSync,
  id: string,
  limit = 100,
): {
  id: string;
  targetKeyId: string;
  processed: number;
  remaining: number;
  status: string;
} {
  const target = activeKeyId(),
    tables = [
      { table: "expansion_secrets", key: "id", column: "ciphertext" },
      { table: "expansion_credentials", key: "id", column: "webhook_secret" },
      { table: "advancement_secret_versions", key: "id", column: "ciphertext" },
      { table: "advancement_mfa", key: "account_id", column: "secret" },
      { table: "advancement_mfa", key: "account_id", column: "pending_secret" },
    ];
  text(id,'회전 작업 ID',100);integer(limit,'회전 배치 크기',1,500);
  const previous=one(db,'SELECT target_key_id FROM advancement_key_rotation WHERE id=?',id);
  if(previous&&previous.target_key_id!==target)throw new HttpError(409,'KEY_ROTATION_TARGET','진행 중 회전 작업의 대상 키가 바뀌었습니다. 새 작업 ID를 사용하세요.');
  let processed = 0,
    remaining = 0;
  transaction(db,()=>{for (const definition of tables) {
    const prefix=`v1:${target}:`,where=target==='legacy'?`${definition.column} LIKE 'v1:%' AND substr(${definition.column},1,?)<>?`:`substr(${definition.column},1,?)<>?`;
    for (const row of many(
      db,
      `SELECT ${definition.key} AS id,${definition.column} AS value FROM ${definition.table} WHERE ${definition.column} IS NOT NULL AND ${definition.column}<>'' AND ${where} ORDER BY ${definition.key} LIMIT ?`,prefix.length,prefix,limit-processed,
    )) {
      if (ciphertextKeyId(String(row.value)) === target) continue;
      if (processed >= limit) {
        remaining++;
        continue;
      }
      const next = encryptSecret(decryptSecret(String(row.value)));
      db.prepare(
        `UPDATE ${definition.table} SET ${definition.column}=? WHERE ${definition.key}=? AND ${definition.column}=?`,
      ).run(next, String(row.id), String(row.value));
      if (definition.table === "advancement_secret_versions")
        db.prepare(
          "UPDATE advancement_secret_versions SET key_id=? WHERE id=?",
        ).run(target, String(row.id));
      processed++;
    }
    remaining+=Number(one(db,`SELECT COUNT(*) AS n FROM ${definition.table} WHERE ${definition.column} IS NOT NULL AND ${definition.column}<>'' AND ${where}`,prefix.length,prefix)?.n??0);
  }
  db.prepare(
    "INSERT INTO advancement_key_rotation VALUES(?,?,?, ?,?,?) ON CONFLICT(id) DO UPDATE SET processed=processed+excluded.processed,status=excluded.status,updated_at=excluded.updated_at",
  ).run(
    id,
    target,
    remaining ? "running" : "completed",
    processed,
    now(),
    now(),
  );
  });
  return {
    id,
    targetKeyId: target,
    processed,
    remaining,
    status: remaining ? "running" : "completed",
  };
}
