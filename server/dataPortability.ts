import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { HttpError } from "./http";
import { MIGRATION_1 } from "./store";
import { MIGRATION_2 } from "./operationsStore";
import { PLATFORM_MIGRATION } from "./platform/schema";
import { TABLE_HISTORY_MIGRATION } from "./tableHistory";
import { EXPANSION_MIGRATION } from "./expansion/schema";
import { WORK_MIGRATION } from "./workQueue";
import { EXPANSION_BUSINESS_MIGRATION } from "./expansion/businessSchema";
import { EXPANSION_SECURITY_MIGRATION } from "./expansion/securitySchema";
import { SYSTEM_MIGRATION } from "./advancement/schema";
import { CONTENT_MIGRATION } from "./advancement/contentSchema";
import { SECURITY_MIGRATION } from "./advancement/securitySchema";
import { RUNTIME_MIGRATION } from "./runtimeSchema";
import { OPERATION_MIGRATION } from "./operationSchema";
import { ASSET_USAGE_MIGRATION } from "./advancement/assetSchema";
import { BOOKING_ADVANCEMENT_MIGRATION } from "./advancement/bookingSchema";
export interface DataManifest { format:1; projectId:string; bytes:number; sha256:string; migrations:number[]; tables:Record<string,number>; activeReleaseId:string|null; checkedAt:string }
export async function inspectPortableDatabase(file:string,projectId:string):Promise<DataManifest> {
  const bytes=await readFile(file);
  if(bytes.length<100||bytes.subarray(0,16).toString("binary")!=="SQLite format 3\0")throw new HttpError(422,"DATABASE_FORMAT","SQLite 데이터 파일이 필요합니다.");
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    if(db.prepare("PRAGMA quick_check").all().some(row=>row.quick_check!=="ok")||db.prepare("PRAGMA foreign_key_check").all().length)throw new HttpError(422,"DATABASE_INTEGRITY","무결성 또는 참조 검증에 실패했습니다.");
    if(db.prepare("SELECT name FROM sqlite_master WHERE type IN('trigger','view')").all().length)throw new HttpError(422,"DATABASE_SCHEMA","지원하지 않는 실행형 DB 정의가 포함되어 있습니다.");
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>String(row.name));
    if(!names.includes("migrations")||!names.includes("submissions")||!names.includes("runtime_state"))throw new HttpError(422,"DATABASE_SCHEMA","운영 DB 계약이 필요합니다.");
    const migrations=db.prepare("SELECT version FROM migrations ORDER BY version").all().map(row=>Number(row.version));
    if(!migrations.length||migrations.some((version,index)=>version!==index+1||version>15))throw new HttpError(422,"DATABASE_VERSION","지원 가능한 연속 DB 버전만 이전할 수 있습니다.");
    const expected=new DatabaseSync(":memory:");
    try{
      for(const migration of [MIGRATION_1,MIGRATION_2,PLATFORM_MIGRATION,TABLE_HISTORY_MIGRATION,EXPANSION_MIGRATION,WORK_MIGRATION,EXPANSION_BUSINESS_MIGRATION,EXPANSION_SECURITY_MIGRATION,SYSTEM_MIGRATION,CONTENT_MIGRATION,SECURITY_MIGRATION,RUNTIME_MIGRATION,OPERATION_MIGRATION,ASSET_USAGE_MIGRATION,BOOKING_ADVANCEMENT_MIGRATION].slice(0,migrations.length))expected.exec(migration);
      const normalize=(sql:unknown):string=>String(sql).replace(/IF NOT EXISTS /gi,"").replace(/\s+/g," ").trim();
      const actual=new Map(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>[String(row.name),normalize(row.sql)]));
      const required=expected.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if(actual.size!==required.length||required.some(row=>actual.get(String(row.name))!==normalize(row.sql)))throw new HttpError(422,"DATABASE_SCHEMA","테이블·제약 조건이 해당 마이그레이션 계약과 일치하지 않습니다.");
    }finally{expected.close();}
    const tables:Record<string,number>={};
    for(const name of names){
      if(!/^[a-z][a-z0-9_]{1,100}$/.test(name))throw new HttpError(422,"DATABASE_SCHEMA","테이블 이름을 확인하세요.");
      tables[name]=Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get()?.n??0);
      const columns=db.prepare(`PRAGMA table_info("${name}")`).all();
      if(columns.some(row=>row.name==="project_id")&&db.prepare(`SELECT 1 FROM "${name}" WHERE project_id<>? LIMIT 1`).get(projectId))throw new HttpError(403,"DATABASE_SCOPE","다른 프로젝트의 데이터가 포함되어 있습니다.");
    }
    const centralRealm=["creator_accounts","creator_sessions","creator_reset_tokens","creator_auth_limits","studio_owner_sessions","expansion_memberships","expansion_project_scopes","expansion_workspace_grants","expansion_project_grants","expansion_sites","expansion_environments","expansion_invites","expansion_credentials","expansion_secrets","expansion_secret_audit","advancement_mfa","advancement_step_up","advancement_service_identities","advancement_service_keys","advancement_secret_versions","advancement_key_rotation","advancement_support_sessions","advancement_auth_tombstones","advancement_config_changes","advancement_flags","advancement_lifecycle","advancement_handoffs"];
    if(centralRealm.some(name=>(tables[name]??0)>0))throw new HttpError(422,"DATABASE_REALM","중앙 제작자 인증·조직 권한·비밀 저장소를 운영 DB에 섞을 수 없습니다.");
    // Migration 5 seeds these two inert defaults in both realms. They confer
    // no rights without a membership/project scope, which is forbidden above.
    if(names.includes('expansion_organizations')&&db.prepare("SELECT 1 FROM expansion_organizations WHERE id<>'local' OR name<>'로컬 조직' LIMIT 1").get()||names.includes('expansion_workspaces')&&db.prepare("SELECT 1 FROM expansion_workspaces WHERE id<>'local' OR organization_id<>'local' OR name<>'기본 작업공간' OR archived<>0 OR config<>'{}' LIMIT 1").get())throw new HttpError(422,'DATABASE_REALM','마이그레이션 기본값 이외의 제작자 조직은 운영 DB에 이전할 수 없습니다.');
    if(names.includes('system_operations')&&db.prepare("SELECT 1 FROM system_operations WHERE realm IN('creator','local-owner','service') LIMIT 1").get())throw new HttpError(422,'DATABASE_REALM','제작자 운영 기록은 방문자 DB에 이전할 수 없습니다.');
    const lease=db.prepare("SELECT value FROM runtime_state WHERE key='activeRelease'").get();
    return {format:1,projectId,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),migrations,tables,activeReleaseId:lease?String(JSON.parse(String(lease.value))):null,checkedAt:new Date().toISOString()};
  } finally {db.close();}
}
