import {createHash,randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {ExpansionScope} from "../src/domain/expansion";
import {HttpError} from "./http";
export interface SystemEvent {id?:string;scope:ExpansionScope;kind:string;sequence:number;payload:unknown;actorId?:string}
/** Caller may include this insert in its business transaction. */
export function enqueueSystemEvent(db:DatabaseSync,event:SystemEvent):string{
 const {scope}=event;
 if(!Number.isSafeInteger(event.sequence)||event.sequence<0||!/^[a-z][a-z0-9.-]{0,79}$/.test(event.kind))throw new HttpError(400,"EVENT_INPUT","전달 이벤트의 종류와 순서를 확인하세요.");
 const payload=JSON.stringify(event.payload),fingerprint=createHash("sha256").update(payload).digest("hex"),dataKey=scope.dataKey??scope.projectId;
 if(Buffer.byteLength(payload)>16_000_000)throw new HttpError(413,"EVENT_SIZE","전달할 데이터가 너무 큽니다.");
 const existing=db.prepare("SELECT id,fingerprint FROM system_event_outbox WHERE data_key=? AND kind=? AND sequence=?").get(dataKey,event.kind,event.sequence);
 if(existing){if(existing.fingerprint!==fingerprint)throw new HttpError(409,"EVENT_SEQUENCE","같은 발행 순서에 다른 내용이 있습니다.");return String(existing.id);}
 const id=event.id??randomUUID();
 db.prepare("INSERT INTO system_event_outbox(id,organization_id,workspace_id,project_id,environment_id,data_key,kind,sequence,payload,fingerprint,actor_id,status,next_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'waiting',?,?)").run(id,scope.organizationId,scope.workspaceId,scope.projectId,scope.environmentId??null,dataKey,event.kind,event.sequence,payload,fingerprint,event.actorId??null,Date.now(),new Date().toISOString());
 return id;
}
export interface DeliveryClaim {id:string;scope:ExpansionScope;kind:string;sequence:number;payload:unknown;fingerprint:string;actorId?:string;token:string}
export class SystemDelivery {
 constructor(readonly db:DatabaseSync,readonly target:(scope:ExpansionScope)=>Promise<{db:DatabaseSync;assertWritable:()=>void}>,readonly authorize:(event:DeliveryClaim)=>void,readonly now:()=>number=Date.now){}
 claim():DeliveryClaim|null{
  this.db.exec("BEGIN IMMEDIATE");try{
   const now=this.now();this.db.prepare("UPDATE system_event_outbox SET status='waiting',lease_token=NULL,lease_until=0 WHERE status='running' AND lease_until<=?").run(now);
   const row=this.db.prepare("SELECT * FROM system_event_outbox WHERE status='waiting' AND next_at<=? ORDER BY created_at,id LIMIT 1").get(now);
   if(!row){this.db.exec("COMMIT");return null;}
   const token=randomUUID();this.db.prepare("UPDATE system_event_outbox SET status='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=? AND status='waiting'").run(token,now+30000,String(row.id));this.db.exec("COMMIT");
   return {id:String(row.id),scope:{organizationId:String(row.organization_id),workspaceId:String(row.workspace_id),projectId:String(row.project_id),...(row.environment_id?{environmentId:String(row.environment_id)}:{}),dataKey:String(row.data_key)},kind:String(row.kind),sequence:Number(row.sequence),payload:JSON.parse(String(row.payload)) as unknown,fingerprint:String(row.fingerprint),actorId:row.actor_id?String(row.actor_id):undefined,token};
  }catch(error){this.db.exec("ROLLBACK");throw error;}
 }
 async deliverOne(afterApply?:()=>void):Promise<boolean>{
  const event=this.claim();if(!event)return false;
  try{
   this.authorize(event);const target=await this.target(event.scope);target.assertWritable();
   if(!this.db.prepare("SELECT id FROM system_event_outbox WHERE id=? AND status='running' AND lease_token=? AND lease_until>?").get(event.id,event.token,this.now()))throw new HttpError(409,"EVENT_LEASE","전달 권한이 만료되었습니다.");
   target.db.exec("BEGIN IMMEDIATE");try{
    const existing=target.db.prepare("SELECT fingerprint FROM system_event_inbox WHERE id=?").get(event.id);
    if(existing&&existing.fingerprint!==event.fingerprint)throw new HttpError(409,"EVENT_INTEGRITY","전달 이벤트 내용이 일치하지 않습니다.");
    if(!existing){
     const newest=Number(target.db.prepare("SELECT MAX(sequence) AS n FROM system_event_inbox WHERE project_id=? AND kind=? AND applied=1").get(event.scope.projectId,event.kind)?.n??-1);
     const applied=event.sequence>newest;
     if(applied){if(event.kind!=="content.snapshot")throw new HttpError(400,"EVENT_KIND","지원하지 않는 전달 종류입니다.");target.db.prepare("INSERT INTO runtime_state(key,value) VALUES('project:cms',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(event.payload));}
     target.db.prepare("INSERT INTO system_event_inbox VALUES(?,?,?,?,?,?,?)").run(event.id,event.scope.projectId,event.kind,event.sequence,event.fingerprint,applied?1:0,new Date().toISOString());
    }
    target.db.exec("COMMIT");
   }catch(error){target.db.exec("ROLLBACK");throw error;}
   afterApply?.();
   this.db.prepare("UPDATE system_event_outbox SET status='delivered',delivered_at=?,lease_token=NULL,lease_until=0,error_code=NULL WHERE id=? AND lease_token=? AND status='running' AND lease_until>?").run(new Date().toISOString(),event.id,event.token,this.now());
  }catch(error){
   const code=error instanceof HttpError?error.code:"EVENT_TEMPORARY",permanent=/AUTH|SCOPE|PERMISSION|DENIED|INTEGRITY|EVENT_KIND/.test(code);
   this.db.prepare("UPDATE system_event_outbox SET status=CASE WHEN ? THEN 'blocked' WHEN attempts>=10 THEN 'failed' ELSE 'waiting' END,error_code=?,next_at=?,lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=? AND status='running'").run(permanent?1:0,code,this.now()+5000,event.id,event.token);
   if(afterApply)throw error;
  }return true;
 }
}
/** Discover persisted environments, including those never opened in this process. */
export function persistedEnvironmentScopes(db:DatabaseSync,limit=20):ExpansionScope[]{
 return db.prepare("SELECT e.*,c.last_checked FROM expansion_environments e JOIN expansion_sites s ON s.id=e.site_id JOIN expansion_workspaces w ON w.id=e.workspace_id LEFT JOIN system_environment_cursors c ON c.environment_id=e.id LEFT JOIN advancement_lifecycle l ON l.organization_id=e.organization_id WHERE s.archived=0 AND w.archived=0 AND (l.state IS NULL OR l.state='active') ORDER BY COALESCE(c.last_checked,0),e.id LIMIT ?").all(limit).map(row=>({organizationId:String(row.organization_id),workspaceId:String(row.workspace_id),projectId:String(row.project_id),siteId:String(row.site_id),environmentId:String(row.id),dataKey:String(row.data_key)}));
}
