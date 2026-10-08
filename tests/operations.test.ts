import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { Store, MIGRATION_1 } from "../server/store";
import { OperationsService } from "../server/operationsService";
import { fail } from "../server/http";
import { createProject, createBlock } from "../src/domain/catalog";
import { commit } from "../src/domain/commands";
import { generate } from "../server/generator";
import { parseProject } from "../src/domain/validation";
import type { ExportResult } from "../src/domain/types";

test("upgrade migrations preserve a populated version-one database and remain idempotent", async () => {
  const { DatabaseSync }=await import("node:sqlite");
  const folder=await mkdtemp(path.join(os.tmpdir(),"automade-migrations-")),file=path.join(folder,"old.sqlite");
  const old=new DatabaseSync(file);old.exec(MIGRATION_1);old.prepare("INSERT INTO migrations VALUES(1,?)").run(new Date().toISOString());
  const project=createProject("existing");old.prepare("INSERT INTO projects VALUES(?,?,?,?)").run(project.id,project.revision,JSON.stringify(project),project.updatedAt);old.prepare("INSERT INTO submissions VALUES(?,?,?,?,?)").run("existing-sub","form","key",JSON.stringify({message:"keep"}),new Date().toISOString());old.close();
  for(let attempt=0;attempt<2;attempt++){const current=new Store(file);try{assert.equal(current.project(project.id)?.name,"existing");assert.equal(current.submissions().length,1);assert.equal(current.db.prepare("SELECT COUNT(*) AS n FROM migrations").get()?.n,15);assert.equal(current.db.prepare("SELECT project_id FROM expansion_project_scopes WHERE project_id=?").get(project.id)?.project_id,project.id);}finally{current.close();}}
  const backups=(await readdir(folder)).filter(name=>name.includes("before-upgrade"));assert.equal(backups.length,1);
  const backup=new DatabaseSync(path.join(folder,backups[0]!),{readOnly:true});try{assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM migrations").get()?.count,1);assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count,1);}finally{backup.close();}
});
test("durable jobs preserve request keys, cancellation and interruption across restart", async () => {
  const folder=await mkdtemp(path.join(os.tmpdir(),"automade-jobs-")),file=path.join(folder,"jobs.sqlite");const project=createProject();
  let store=new Store(file);const id=randomUUID();
  store.operations.createJob(id,project,"retry-key","hash");store.operations.stage(id,"build");store.close();
  store=new Store(file);try{store.recoverInterrupted();assert.equal(store.operations.request(project.id,"retry-key")?.id,id);assert.equal(store.operations.job(id)?.errorCode,"PROCESS_INTERRUPTED");assert.equal(store.operations.job(id)?.retryable,true);assert.equal(store.operations.job(id)?.checkpoints[1]?.stage,"build");}finally{store.close();}
});
test("write leases reject old releases and transient pauses without losing stored data", () => {
  const store=new Store(":memory:");try{store.activateRelease("release-two");assert.throws(()=>store.assertWritable("release-one"),/읽기 전용/);store.assertWritable("release-two");store.pauseProjectWrites(true);assert.throws(()=>store.assertWritable("release-two"),/보존 중/);store.pauseProjectWrites(false);store.assertWritable("release-two");}finally{store.close();}
});
test("inquiry workflow filters and masking preserve idempotent records and hide bodies from audits",()=>{
  const store=new Store(":memory:");try{const a=store.submit("form","a",{email:"private@example.org",message:"quote_%"}),b=store.submit("other","b",{message:"hello"});
    store.operations.updateSubmission(a.id,{status:"processing",tags:["urgent"],note:"call",assignee:"operator"});
    assert.equal(store.operations.submissions({limit:50,offset:0,status:"processing"}).total,1);
    assert.equal(store.operations.submissions({limit:50,offset:0,query:"_%"}).items[0]?.id,a.id);
    assert.equal(store.operations.submissions({limit:1,offset:1}).total,2);
    assert.throws(()=>store.operations.updateSubmission(b.id,{status:"unsupported"}));
    assert.throws(()=>store.operations.updateSubmission(b.id,{tags:[42]}));
    const masked=store.operations.updateSubmission(a.id,{action:"mask"});assert.equal(masked.values.email,"[마스킹됨]");assert.equal(store.operations.submissions({limit:50,offset:0,query:"private@example.org"}).total,0);
    assert.ok(!JSON.stringify(store.audits()).includes("private@example.org"));
  }finally{store.close();}
});
test("canonical operating data survives regeneration, old restart, stopped inquiry access and backup restoration",async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),"automade-service-")),exports=path.join(folder,"exports"),data=path.join(folder,"data");await mkdir(exports);await mkdir(data);
  const store=new Store(path.join(data,"studio.sqlite")),service=new OperationsService(store,process.cwd(),exports,data);
  const server=createServer((req,res)=>{void service.handle(req,res,new URL(req.url??"/","http://local")).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(error=>fail(res,error,"test"));});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");const origin=`http://127.0.0.1:${address.port}`;
  const p=createProject("operating");p.settings.description="real data";const form=createBlock("form",p,p.pages[0]!.id);p.blocks.push(form);
  const wait=async(id:string):Promise<ExportResult>=>{const end=Date.now()+15000;while(Date.now()<end){const job=store.operations.job(id);if(job?.status==="ready"&&job.result)return job.result;if(job?.status==="failed")throw new Error(job.error);await new Promise(resolve=>setTimeout(resolve,20));}throw new Error("Generation timeout");};
  const submit=(url:string,key:string)=>fetch(url+"/api/forms/"+form.id,{method:"POST",headers:{Origin:url,"Content-Type":"application/json"},body:JSON.stringify({idempotencyKey:key,values:{name:"test",email:"test@example.org",message:key}})});
  try{
    const [firstId,duplicateId]=await Promise.all([service.enqueue(p,"first"),service.enqueue(p,"first")]);assert.equal(firstId,duplicateId);
    const first=await wait(firstId);assert.equal((await submit(first.url,"before")).status,201);
    const busyLease=service.leases.acquire(`generation:${p.id}`,"other-process");
    try{await assert.rejects(service.enqueue(p,"busy-generation"),/다른 작업/);assert.equal((await service.projectData(p.id)).db.prepare("SELECT value FROM platform_usage WHERE project_id=? AND metric='generations'").get(p.id)?.value,1);}finally{busyLease.release();}
    const next=commit(p,draft=>{draft.name="updated";});const secondId=await service.enqueue(next,"second"),second=await wait(secondId);
    const operating=await service.projectData(p.id);
    assert.equal(operating.db.prepare("SELECT value FROM platform_usage WHERE project_id=? AND metric='generations'").get(p.id)?.value,2);
    assert.ok((await service.measureStorage(p.id))>0);
    assert.equal((await submit(first.url,"old-refused")).status,409);assert.equal((await submit(second.url,"after")).status,201);
    assert.equal(await service.enqueue(next,"second"),secondId);await assert.rejects(service.enqueue({...next,name:"conflict"},"second"),/同|동일/);
    assert.equal(operating.db.prepare("SELECT value FROM platform_usage WHERE project_id=? AND metric='generations'").get(p.id)?.value,2);
    const stop=await fetch(origin+`/api/exports/${secondId}/stop`,{method:"POST"});assert.equal(stop.status,200);
    const page=await (await fetch(origin+`/api/exports/${secondId}/submissions?includeMeta=1`)).json();assert.equal(page.data.total,2);
    const backup=await (await fetch(origin+`/api/projects/${p.id}/data-backups`,{method:"POST"})).json();assert.equal(backup.data.submissions,2);
    const restart=await (await fetch(origin+`/api/exports/${firstId}/restart`,{method:"POST"})).json();assert.equal(restart.data.readOnly,true);assert.equal((await submit(restart.data.url,"old-again")).status,409);
    const resumed=await (await fetch(origin+`/api/exports/${secondId}/restart`,{method:"POST"})).json();assert.equal((await submit(resumed.data.url,"later")).status,201);
    let releaseBusy:()=>void=()=>{};const busy=service.withProjectRequest(p.id,()=>new Promise<void>(resolve=>{releaseBusy=resolve;}));
    const blockedRestore=await fetch(origin+`/api/projects/${p.id}/data-backups/${backup.data.id}/restore`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:true})});assert.equal(blockedRestore.status,409);releaseBusy();await busy;
    const otherStore=new Store(path.join(data,"studio.sqlite")),otherService=new OperationsService(otherStore,process.cwd(),exports,data);
    try{await otherService.projectData(p.id);const crossProcessRestore=await fetch(origin+`/api/projects/${p.id}/data-backups/${backup.data.id}/restore`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:true})});assert.equal(crossProcessRestore.status,409);assert.equal((await otherService.projectData(p.id)).submissions().length,3);}finally{await otherService.close();otherStore.close();}
    const restored=await fetch(origin+`/api/projects/${p.id}/data-backups/${backup.data.id}/restore`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:true})});assert.equal(restored.status,200);
    const restoredPage=await (await fetch(origin+`/api/exports/${secondId}/submissions?includeMeta=1`)).json();assert.equal(restoredPage.data.total,2);
    assert.ok(store.operations.backups(p.id).some(backup=>backup.reason==="before-restore"));
    assert.equal((await fetch(origin+`/api/projects/${p.id}/data-backups/${backup.data.id}/download`)).status,200);
  }finally{await service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});
test("typed snapshot lifecycle and generated rebuild include CMS routes and SEO documents",async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),"automade-seo-")),project=createProject("CMS");project.settings.description="content";project.settings.siteUrl="https://example.org";
  project.collections=[{id:"works",name:"Work",path:"/works",records:[{id:"work-one",slug:"one",title:"Published",body:"details",category:"",imageId:"",status:"published",publishedAt:new Date().toISOString(),fields:{}}]}];
  const events:string[]=[];const result=await generate(parseProject(project),{root:folder,sourceRoot:process.cwd(),id:randomUUID(),lifecycle:event=>events.push(event)});
  assert.deepEqual(events,["before-data-snapshot","after-data-snapshot"]);
  assert.match(await readFile(path.join(result.source,"dist/works/one/index.html"),"utf8"),/Published/);
  assert.match(await readFile(path.join(result.source,"dist/sitemap.xml"),"utf8"),/https:\/\/example.org\/works\/one/);
  assert.match(await readFile(path.join(result.source,"build.mjs"),"utf8"),/siteRoutes/);
});
