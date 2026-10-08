import path from "node:path";
import { mkdir, realpath, lstat } from "node:fs/promises";
import { Store } from "./store";
import { ExpansionService } from "./expansion/service";
import { WorkQueue, type WorkClaim } from "./workQueue";
import { record } from "../src/domain/validation";
import { contained, HttpError } from "./http";
import type { ExpansionScope } from "../src/domain/expansion";
import { ConfigService } from "./advancement/config";
import { AuditJournal } from "./advancement/audit";
import { operationContext, newOperation } from "./operationContext";
import { workerEnvelope } from "./workerProtocol";
import { beginWorkerUsage } from "./workerUsage";
process.once("disconnect", () => process.exit(1));
process.once("message", (input: unknown) => {
  const usage=beginWorkerUsage();
  void (async () => {
    const value=workerEnvelope(input);
    if(typeof value.studioFile!=="string"||typeof value.dataRoot!=="string"||typeof value.jobId!=="string"||typeof value.leaseToken!=="string"||typeof value.workerId!=="string")throw new HttpError(400,"WORK_INPUT","worker 입력을 확인하세요.");
    const studio=new Store(value.studioFile),stores=new Map<string,Store>(),persisted=studio.db.prepare("SELECT body FROM system_worker_policy WHERE id='global'").get(),maxRunning=persisted?Number(record(JSON.parse(String(persisted.body))).maxRunning):2,queue=new WorkQueue(studio.db,value.workerId,maxRunning);
    const row=queue.get(value.jobId);if(!row)throw new HttpError(404,"WORK_NOT_FOUND","작업을 찾을 수 없습니다.");
    const claim:WorkClaim={...row,leaseToken:value.leaseToken,workerId:value.workerId,leaseUntil:0};
    const policy=new ConfigService(studio.db,new AuditJournal(studio.db));
    const assertCurrent=():void=>{if(!process.connected)throw new HttpError(409,"WORK_LEASE_LOST","worker 연결이 종료되었습니다.");queue.assertCurrent(claim);policy.assertLifecycle(row.scope);policy.assertEnabled(row.scope,row.kind==='workflow.run'?'automation':row.kind.startsWith('site.')||row.kind.startsWith('content.')?'publication':'paid-actions');};
    const expansion=new ExpansionService(studio,{dataRoot:value.dataRoot,assertJobLease:assertCurrent,
      siteData:async(scope:ExpansionScope)=>{
        const owned=expansion.access.resolve(scope),key=owned.dataKey??owned.projectId;
        assertCurrent();const cached=stores.get(key);if(cached)return cached;
        const folder=path.join(String(value.dataRoot),"sites",key);await mkdir(folder,{recursive:true});
        if(!contained(await realpath(String(value.dataRoot)),await realpath(folder)))throw new HttpError(403,"PATH","worker 저장소 경로를 확인하세요.");
        const pointer=studio.operations.state('storage:active:'+key),candidate=pointer?record(pointer).file:undefined;
        if(candidate!==undefined&&(typeof candidate!=='string'||!path.isAbsolute(candidate)||!candidate.endsWith('.sqlite')))throw new HttpError(403,'STORAGE_PATH','전환 저장소의 절대 SQLite 경로가 필요합니다.');
        const file=typeof candidate==='string'?candidate:path.join(folder,'site.sqlite'),root=path.resolve(String(value.dataRoot));
        if(!contained(root,path.resolve(file)))throw new HttpError(403,'STORAGE_PATH','전환 저장소가 데이터 루트 밖에 있습니다.');
        let current=root;for(const part of path.relative(root,file).split(path.sep).filter(Boolean)){if((await lstat(current)).isSymbolicLink())throw new HttpError(403,'STORAGE_PATH','연결 경로를 통한 저장소 전환은 허용하지 않습니다.');current=path.join(current,part);}
        const entry=await lstat(file).catch(error=>{if(!candidate&&error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')return null;throw error;});
        if(entry&&(entry.isSymbolicLink()||!entry.isFile()||!contained(await realpath(root),await realpath(file))))throw new HttpError(403,'STORAGE_PATH','전환 저장소 원본 파일을 확인하세요.');
        assertCurrent();const store=new Store(file);stores.set(key,store);expansion.configureRuntime(owned,store);return store;
      },
      enqueueJob:async(kind,scope,payload,key,actor,options)=>{assertCurrent();const next=queue.enqueue(kind,scope,payload,key,actor,options);return{id:next.id,status:next.status};},
    });
    if(value.traceparent!==undefined&&(typeof value.traceparent!=='string'||!/^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/.test(value.traceparent)))throw new HttpError(400,'WORK_TRACE','worker 추적 계약을 확인하세요.');
    const context=newOperation(row.id),details=studio.db.prepare('SELECT trace_id FROM system_work_details WHERE work_id=?').get(row.id);context.traceId=typeof value.traceparent==='string'?value.traceparent.split('-')[1]!:details?String(details.trace_id):context.traceId;context.scope=row.scope;context.actorKey=row.actorId;context.realm='system';
    try{await operationContext.run(context,async()=>{assertCurrent();const result=await expansion.executeJob(row.kind,row.scope,row.payload,row.actorId,assertCurrent);assertCurrent();process.send?.({protocol:1,type:"result",result,usage:usage.finish()},()=>process.exit(0));});}
    finally{for(const store of stores.values())store.close();studio.close();}
  })().catch((error:unknown)=>{process.send?.({protocol:1,type:"error",code:error instanceof HttpError?error.code:"WORK_FAILED",message:error instanceof HttpError?error.message:"worker가 작업을 완료하지 못했습니다.",usage:usage.finish()},()=>process.exit(1));});
});
