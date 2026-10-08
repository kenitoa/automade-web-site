import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  writeFile,
  copyFile,
  realpath,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { Store } from "../store";
import { Store as DatabaseStore } from "../store";
import type { ExpansionService } from "../expansion/service";
import type { ExpansionScope } from "../../src/domain/expansion";
import type { BackupSet } from "../../src/domain/advancement";
import { HttpError, contained } from "../http";
import { many, now } from "../platform/common";
import { ciphertextKeyId, configuredKeys, decryptSecret } from "./keyring";
import { BlobService } from "../expansion/blobs";
import {captureArtifacts,verifyArtifactBackups,restoreArtifactBackups} from '../artifactBackups';
import {ResourceLeases} from '../workQueue';
async function digest(
  file: string,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}
export class BackupService {
  readonly root: string;
  constructor(
    readonly store: Store,
    readonly expansion: ExpansionService,
    readonly dataRoot: string,
    readonly exportRoot?:string,
  ) {
    this.root = path.resolve(dataRoot, "backup-sets");
  }
  private save(value: BackupSet): void {
    this.store.db
      .prepare(
        "INSERT INTO advancement_backup_sets VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest",
      )
      .run(
        value.id,
        JSON.stringify(value.scope),
        JSON.stringify(value),
        value.createdAt,
      );
  }
  list(scope: ExpansionScope): BackupSet[] {
    return many(
      this.store.db,
      "SELECT manifest FROM advancement_backup_sets WHERE json_extract(scope,'$.organizationId')=? AND json_extract(scope,'$.projectId')=? AND COALESCE(json_extract(scope,'$.environmentId'),'')=? ORDER BY created_at DESC LIMIT 100",
      scope.organizationId,
      scope.projectId,
      scope.environmentId ?? "",
    ).map((row) => JSON.parse(String(row.manifest)));
  }
  async create(
    scope: ExpansionScope,
    site: Store,
    freeze?: <T>(
      scope: ExpansionScope,
      work: (site: Store) => Promise<T>,
    ) => Promise<T>,
  ): Promise<BackupSet> {
    await mkdir(this.root, { recursive: true });
    if (!contained(await realpath(this.dataRoot), await realpath(this.root)))
      throw new HttpError(403, "BACKUP_PATH", "백업 루트 경로를 확인하세요.");
    const id = randomUUID(),
      directory = path.join(this.root, id);
    await mkdir(directory);
    const result: BackupSet = {
      id,
      scope,
      state: "creating",
      files: [],
      keyIds: [],
      createdAt: now(),
      verifiedAt: null,
      errorCode: null,
      consistency: freeze ? "scoped-freeze" : "online-per-database",
    };
    this.save(result);
    try {
      const capture = async (source: Store): Promise<void> => {
        const central = path.join(directory, "central.sqlite"),
          environment = path.join(directory, "environment.sqlite");
        this.store.snapshot(central);
        source.snapshot(environment);
        result.files.push(
          {
            kind: "central",
            path: "central.sqlite",
            ...(await digest(central)),
          },
          {
            kind: "environment",
            path: "environment.sqlite",
            scope,
            ...(await digest(environment)),
          },
        );
        if(this.exportRoot)result.artifacts=await captureArtifacts(central,this.exportRoot,directory,scope,new ResourceLeases(this.store.db));
        // Read references and encrypted-key versions from the captured bytes. Live
        // metadata may change during the asynchronous blob copy.
        const snapshot = new DatabaseSync(central, { readOnly: true });
        try {
          await mkdir(path.join(directory, "blobs"));
          const blobs = new BlobService(snapshot, this.dataRoot),
            refs = many(
              snapshot,
              "SELECT id,sha256 FROM expansion_blob_refs WHERE organization_id=? AND project_id=? ORDER BY sha256",
              scope.organizationId,
              scope.projectId,
            ),
            seen = new Set<string>();
          for (const ref of refs) {
            const sha = String(ref.sha256);
            if (seen.has(sha)) continue;
            const blob = await blobs.read(scope.projectId, String(ref.id)),
              file = path.join(directory, "blobs", sha);
            await writeFile(file, blob.data, { flag: "wx", mode: 0o600 });
            result.files.push({
              kind: "blob",
              path: "blobs/" + sha,
              ...(await digest(file)),
            });
            seen.add(sha);
          }
          const keyQuery =
            "SELECT ciphertext AS value FROM expansion_secrets UNION ALL SELECT webhook_secret AS value FROM expansion_credentials WHERE webhook_secret IS NOT NULL UNION ALL SELECT ciphertext AS value FROM advancement_secret_versions UNION ALL SELECT secret AS value FROM advancement_mfa WHERE secret IS NOT NULL UNION ALL SELECT pending_secret AS value FROM advancement_mfa WHERE pending_secret IS NOT NULL";
          for (const row of many(snapshot, keyQuery))
            result.keyIds.push(ciphertextKeyId(String(row.value)));
          const environmentSnapshot = new DatabaseSync(environment, {
            readOnly: true,
          });
          try {
            for (const row of many(environmentSnapshot, keyQuery))
              result.keyIds.push(ciphertextKeyId(String(row.value)));
          } finally {
            environmentSnapshot.close();
          }
          result.keyIds = [...new Set(result.keyIds)].sort();
          for (const key of result.keyIds)
            if (!configuredKeys().has(key))
              throw new HttpError(
                503,
                "BACKUP_KEY_MISSING",
                "복원에 필요한 암호화 키를 확인하세요.",
              );
        } finally {
          snapshot.close();
        }
      };
      if (freeze) await freeze(scope, capture);
      else await capture(site);
      result.state = "verified";
      result.verifiedAt = now();
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify(result, null, 2),
        { flag: "wx", mode: 0o600 },
      );
      this.save(result);
      return result;
    } catch (error) {
      result.state = "failed";
      result.errorCode =
        error instanceof HttpError ? error.code : "BACKUP_FAILED";
      this.save(result);
      throw error;
    }
  }
  async verify(scope: ExpansionScope, id: string): Promise<BackupSet> {
    const value = this.list(scope).find((item) => item.id === id);
    if (!value || value.state !== "verified")
      throw new HttpError(
        404,
        "BACKUP_SET",
        "검증된 백업 집합을 찾을 수 없습니다.",
      );
    const root = await realpath(path.join(this.root, id));
    if (!contained(await realpath(this.root), root))
      throw new HttpError(403, "BACKUP_PATH", "백업 경로를 확인하세요.");
    for (const item of value.files) {
      const file = await realpath(path.join(root, item.path));
      if (!contained(root, file))
        throw new HttpError(403, "BACKUP_PATH", "백업 파일 경로를 확인하세요.");
      const actual = await digest(file);
      if (actual.sha256 !== item.sha256 || actual.bytes !== item.bytes)
        throw new HttpError(
          409,
          "BACKUP_INTEGRITY",
          "백업 파일 해시 또는 크기가 다릅니다.",
        );
    }
    for (const key of value.keyIds)
      if (!configuredKeys().has(key))
        throw new HttpError(
          503,
          "BACKUP_KEY_MISSING",
          "이 백업에 필요한 키 버전을 복구하세요.",
        );
    await verifyArtifactBackups(root,value.artifacts??[]);
    return value;
  }
  async rehearse(
    scope: ExpansionScope,
    id: string,
  ): Promise<{
    verified: true;
    files: number;
    databaseChecks: number;
    artifactChecks:number;
    credentialInvalidated: boolean;
    durationMs: number;
  }> {
    const started = Date.now(),
      value = await this.verify(scope, id),
      directory = path.join(this.root, id, "rehearsal-" + randomUUID());
    await mkdir(directory);
    let checks = 0;
    for (const item of value.files.filter((item) => item.kind !== "blob")) {
      const target = path.join(directory, path.basename(item.path));
      await copyFile(path.join(this.root, id, item.path), target);
      const database = new DatabaseStore(target);
      try {
        if (
          database.db
            .prepare("PRAGMA quick_check")
            .all()
            .some((row) => row.quick_check !== "ok") ||
          database.db.prepare("PRAGMA foreign_key_check").all().length
        )
          throw new HttpError(
            409,
            "BACKUP_DATABASE_INTEGRITY",
            "복원 DB 무결성이 다릅니다.",
          );
        for (const row of many(
          database.db,
          "SELECT ciphertext AS value FROM expansion_secrets UNION ALL SELECT webhook_secret AS value FROM expansion_credentials WHERE webhook_secret IS NOT NULL UNION ALL SELECT ciphertext AS value FROM advancement_secret_versions UNION ALL SELECT secret AS value FROM advancement_mfa WHERE secret IS NOT NULL UNION ALL SELECT pending_secret AS value FROM advancement_mfa WHERE pending_secret IS NOT NULL",
        ))
          decryptSecret(String(row.value));
        database.db.prepare("DELETE FROM creator_sessions").run();
        database.db.prepare("DELETE FROM platform_sessions").run();
        database.db.prepare("DELETE FROM platform_reset_tokens").run();
        checks++;
      } finally {
        database.close();
      }
    }
    const artifacts=await restoreArtifactBackups(path.join(this.root,id),value.artifacts??[],path.join(directory,'exports'));
    return {
      verified: true,
      files: value.files.length,
      databaseChecks: checks,
      artifactChecks:artifacts.restored+artifacts.preserved,
      credentialInvalidated: true,
      durationMs: Date.now() - started,
    };
  }
  async environmentFile(scope: ExpansionScope, id: string): Promise<string> {
    const value = await this.verify(scope, id),
      item = value.files.find((file) => file.kind === "environment");
    if (!item)
      throw new HttpError(404, "BACKUP_ENVIRONMENT", "환경 DB가 없습니다.");
    return path.join(this.root, id, item.path);
  }
  async restoreArtifacts(scope:ExpansionScope,id:string):Promise<{restored:number;preserved:number}>{const value=await this.verify(scope,id);if(!value.artifacts?.length)return {restored:0,preserved:0};if(!this.exportRoot)throw new HttpError(503,'BACKUP_EXPORT_ROOT','릴리스 복원 대상 저장소가 필요합니다.');return restoreArtifactBackups(path.join(this.root,id),value.artifacts,this.exportRoot);}
}
