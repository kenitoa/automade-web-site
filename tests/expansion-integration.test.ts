import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir,writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store";
import { WorkQueue } from "../server/workQueue";
import { executeInWorker } from "../server/workerClient";
import { startSiteInWorker } from "../server/workerClient";
import { ResourceLeases } from "../server/workQueue";
import { generate } from "../server/generator";
import { createBlock } from "../src/domain/catalog";
import { randomUUID } from "node:crypto";
import { ExpansionService } from "../server/expansion/service";
import { OperationsService } from "../server/operationsService";
import { createProject } from "../src/domain/catalog";
import { inspectPortableDatabase } from "../server/dataPortability";

test("environment databases preserve production IDs and isolate transactions",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"automade-env-")),data=path.join(root,"data"),exports=path.join(root,"exports");await mkdir(data);await mkdir(exports);
  const store=new Store(path.join(data,"studio.sqlite")),operations=new OperationsService(store,process.cwd(),exports,data);
  const expansion=new ExpansionService(store,{mode:"local",dataRoot:data,siteData:scope=>operations.scopeData(scope),enqueueJob:async()=>{throw new Error("not invoked");}});
  try{
    const project=createProject("isolated");store.save(project);const production=expansion.registerProject(project,"local",null,true);
    const environment=expansion.organizations.createEnvironment(null,true,{siteId:production.siteId,name:"검수",kind:"staging",config:{}}),staging=expansion.resolveEnvironmentScope(environment.id);
    const first=await operations.scopeData(production),second=await operations.scopeData(staging);
    first.submit("form","same-key",{message:"production"});second.submit("form","same-key",{message:"staging"});
    assert.equal(first.operations.submissions({limit:10,offset:0}).items[0]?.values.message,"production");assert.equal(second.operations.submissions({limit:10,offset:0}).items[0]?.values.message,"staging");
    assert.equal(production.dataKey,project.id);assert.notEqual(staging.dataKey,production.dataKey);
    const before=await operations.measureStorage(project.id,staging);await writeFile(path.join(data,"sites",staging.dataKey!,"capacity-evidence.bin"),Buffer.alloc(512000));const measured=await operations.measureStorage(project.id,staging);assert.ok(measured>=before+512000);assert.equal(second.db.prepare("SELECT value FROM platform_usage WHERE project_id=? AND metric='storageBytes'").get(project.id)?.value,measured);
    await assert.rejects(operations.scopeData({...staging,dataKey:production.dataKey}),/범위/);
    await assert.rejects(operations.scopeData({...staging,organizationId:"other"}),/범위/);
  }finally{await operations.close();store.close();}
});

test("two persistent coordinators claim once and real isolated worker completes a registered usecase",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"automade-worker-")),data=path.join(root,"data");await mkdir(data);
  const file=path.join(data,"studio.sqlite"),store=new Store(file),second=new Store(file);
  const expansion=new ExpansionService(store,{mode:"local",dataRoot:data,siteData:async()=>{throw new Error("child owns storage");},enqueueJob:async()=>{throw new Error("not invoked");}});
  try{
    const project=createProject("worker");store.save(project);const scope=expansion.registerProject(project,"local",null,true),a=new WorkQueue(store.db,"first",1),b=new WorkQueue(second.db,"second",1);
    const item=a.enqueue("booking.waitlist",scope,{},"one","local-owner");
    const claim=a.claim()!;assert.equal(claim.id,item.id);assert.equal(b.claim(),null);
    const result=await executeInWorker(process.cwd(),file,data,item,AbortSignal.timeout(10000));assert.ok(result&&typeof result==="object");assert.equal(a.complete(claim,result),true);assert.equal(b.get(item.id)?.status,"succeeded");
    assert.equal(b.claim(),null);
  }finally{second.close();store.close();}
});

test("portable online snapshot validates schema, scope, foreign keys and realm without changing the source",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"automade-portable-")),source=path.join(root,"site.sqlite"),backup=path.join(root,"copy.sqlite"),store=new Store(source);
  try{store.submit("form","one",{message:"retained"});store.snapshot(backup);
    const manifest=await inspectPortableDatabase(backup,"site");assert.equal(manifest.migrations.length,15);assert.equal(manifest.tables.submissions,1);assert.match(manifest.sha256,/^[a-f0-9]{64}$/);
    const other=new Store(backup);try{other.db.prepare("INSERT INTO platform_usage VALUES('foreign','generations','2026-10',1)").run();}finally{other.close();}
    await assert.rejects(inspectPortableDatabase(backup,"site"),/다른 프로젝트/);
  }finally{store.close();}
});

test("an isolated serving process rejects requests after its persistent resource lease expires",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"automade-site-lease-")),studioFile=path.join(root,"studio.sqlite"),dataFile=path.join(root,"site.sqlite"),studio=new Store(studioFile),project=createProject("fenced serving"),form=createBlock("form",project,project.pages[0]!.id);project.blocks.push(form);
  const id=randomUUID(),leases=new ResourceLeases(studio.db),resources=[`artifact:${id}`,`site-data:${project.id}`],claims=resources.map(resource=>leases.acquire(resource,"coordinator","shared"));
  let site:Awaited<ReturnType<typeof startSiteInWorker>>|undefined;
  try{const result=await generate(project,{root:path.join(root,"exports"),sourceRoot:process.cwd(),dataFile,id});site=await startSiteInWorker(process.cwd(),result.source,project,{dataFile,releaseId:id,leaseGuard:{studioFile,tokens:resources.map((resource,i)=>({resource,token:claims[i]!.token}))}});assert.equal((await fetch(site.origin+"/health")).status,200);
    studio.db.prepare("UPDATE resource_leases SET expires_at=? WHERE owner='coordinator'").run(Date.now()-1);
    const response=await fetch(site.origin+"/api/forms/"+form.id,{method:"POST",headers:{Origin:site.origin,"Content-Type":"application/json"},body:JSON.stringify({idempotencyKey:"late",values:{name:"test",email:"test@example.org",message:"must not write"}})});assert.equal(response.status,409);assert.equal((await response.json()).error.code,"LEASE_LOST");assert.equal(site.store.submissions().length,0);
  }finally{await site?.close();claims.forEach(claim=>claim.release());studio.close();}
});
