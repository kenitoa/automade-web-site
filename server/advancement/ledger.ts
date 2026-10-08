import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { FinancialEntry } from "../../src/domain/advancement";
import { HttpError } from "../http";
import { integer, many, now, one, text } from "../platform/common";
import { fingerprint } from "./common";
export function recordFinancialEntry(db:DatabaseSync,input:{realm:"orders"|"subscriptions";projectId:string;targetId:string;key:string;kind:string;amountMinor:number;currency:string;commandId?:string;eventId?:string}):void {
  if(!one(db,"SELECT name FROM sqlite_master WHERE name='advancement_financial_entries'"))return;
  integer(input.amountMinor,"원장 금액",0,Number.MAX_SAFE_INTEGER);if(!/^[A-Z]{3}$/.test(input.currency))throw new HttpError(400,"LEDGER_CURRENCY","통화를 확인하세요.");text(input.key,"원장 키",250);const digest=fingerprint(input),old=one(db,"SELECT fingerprint FROM advancement_financial_entries WHERE realm=? AND project_id=? AND entry_key=?",input.realm,input.projectId,input.key);if(old){if(old.fingerprint!==digest)throw new HttpError(409,"LEDGER_IDEMPOTENCY","같은 원장 키의 내역이 다릅니다.");return;}db.prepare("INSERT INTO advancement_financial_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),input.realm,input.projectId,input.targetId,input.key,input.kind,input.amountMinor,input.currency,input.commandId??null,input.eventId??null,digest,now());
}
export function ledger(db:DatabaseSync,projectId:string,realm:string,limit=50,before?:string):{items:FinancialEntry[];nextCursor:string|null} {const entries=many(db,"SELECT * FROM advancement_financial_entries WHERE project_id=? AND realm=? AND (? IS NULL OR created_at||'/'||id<?) ORDER BY created_at DESC,id DESC LIMIT ?",projectId,realm,before??null,before??null,limit).map(row=>({id:String(row.id),realm:String(row.realm) as FinancialEntry["realm"],projectId,targetId:String(row.target_id),kind:String(row.kind),amountMinor:Number(row.amount_minor),currency:String(row.currency),commandId:row.command_id?String(row.command_id):null,eventId:row.event_id?String(row.event_id):null,createdAt:String(row.created_at)}));return {items:entries,nextCursor:entries.length===limit?entries.at(-1)!.createdAt+"/"+entries.at(-1)!.id:null};}
