import type { DatabaseSync } from "node:sqlite";
import type { AuditEntry } from "../../src/domain/advancement";
import { many, now, one } from "../platform/common";
import { fingerprint } from "./common";
export class AuditJournal {
  constructor(readonly db: DatabaseSync) {}
  append(organizationId: string, actorId: string, operation: string, resourceId: string, status = "success", beforeRevision: number | null = null, afterRevision: number | null = null): void {
    const previousHash = String(one(this.db,"SELECT hash FROM advancement_audit ORDER BY sequence DESC LIMIT 1")?.hash ?? ""), createdAt = now(), value = { organizationId,actorId,operation,resourceId,status,beforeRevision,afterRevision,previousHash,createdAt };
    this.db.prepare("INSERT INTO advancement_audit(organization_id,actor_id,operation,resource_id,status,before_revision,after_revision,previous_hash,hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(organizationId,actorId,operation,resourceId,status,beforeRevision,afterRevision,previousHash,fingerprint(value),createdAt);
  }
  list(organizationId: string, before = Number.MAX_SAFE_INTEGER, limit = 50): { items: AuditEntry[]; nextCursor: number | null } {
    const rows=many(this.db,"SELECT * FROM advancement_audit WHERE organization_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",organizationId,before,limit).map(row=>({sequence:Number(row.sequence),organizationId:String(row.organization_id),actorId:String(row.actor_id),operation:String(row.operation),resourceId:String(row.resource_id),status:String(row.status),beforeRevision:row.before_revision===null?null:Number(row.before_revision),afterRevision:row.after_revision===null?null:Number(row.after_revision),previousHash:String(row.previous_hash),hash:String(row.hash),createdAt:String(row.created_at)})); return {items:rows,nextCursor:rows.length===limit?rows.at(-1)!.sequence:null};
  }
  checkpoint(): { sequence: number; hash: string; createdAt: string } { const row=one(this.db,"SELECT sequence,hash,created_at FROM advancement_audit ORDER BY sequence DESC LIMIT 1");return {sequence:Number(row?.sequence??0),hash:String(row?.hash??""),createdAt:String(row?.created_at??now())}; }
}
