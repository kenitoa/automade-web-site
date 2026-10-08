import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeVaultKey } from "../server/localVault";
import { Store } from "../server/store";
import { ResourceLeases,WorkQueue } from "../server/workQueue";
import { createProject } from "../src/domain/catalog";
import { reserveGeneration } from "../server/generationBudget";
import { ExpansionService } from "../server/expansion/service";

test("local vault key persists across startups and managed mode never silently provisions one",async()=>{
  const previous=process.env.EXPANSION_SECRET_KEY,root=await mkdtemp(path.join(os.tmpdir(),"automade-vault-"));
  try{delete process.env.EXPANSION_SECRET_KEY;await initializeVaultKey(root,"managed");assert.equal(process.env.EXPANSION_SECRET_KEY,undefined);await assert.rejects(access(path.join(root,"keys","expansion.key")));
    await initializeVaultKey(root,"local");const first=process.env.EXPANSION_SECRET_KEY;assert.match(first!,/^[a-f0-9]{64}$/);delete process.env.EXPANSION_SECRET_KEY;await initializeVaultKey(root,"local");assert.equal(process.env.EXPANSION_SECRET_KEY,first);assert.equal((await readFile(path.join(root,"keys","expansion.key"),"utf8")).trim(),first);
    process.env.EXPANSION_SECRET_KEY="invalid";await assert.rejects(initializeVaultKey(root,"local"),/64 hexadecimal/);
  }finally{if(previous===undefined)delete process.env.EXPANSION_SECRET_KEY;else process.env.EXPANSION_SECRET_KEY=previous;}
});
test("restart recovery preserves live generation and fails only the expired owner",()=>{
  const store=new Store(":memory:");try{const project=createProject("fenced");store.save(project);store.operations.createJob("release",project,"one","fingerprint");const lease=new ResourceLeases(store.db).acquire(`generation:${project.id}`,"coordinator");
    store.recoverInterrupted();assert.equal(store.operations.job("release")?.status,"building");assert.equal(store.exportRecord("release")?.status,"building");
    store.db.prepare("UPDATE resource_leases SET expires_at=? WHERE token=?").run(Date.now()-1,lease.token);store.recoverInterrupted();assert.equal(store.operations.job("release")?.errorCode,"PROCESS_INTERRUPTED");assert.equal(store.exportRecord("release")?.status,"failed");
  }finally{store.close();}
});
test("retry cannot bypass the organization waiting quota",()=>{
  const store=new Store(":memory:"),queue=new WorkQueue(store.db);try{const scope={organizationId:"org",workspaceId:"workspace",projectId:"project"};queue.limits("org",1,1);const cancelled=queue.enqueue("content.publish",scope,{},"one");queue.cancel(cancelled.id);queue.enqueue("content.publish",scope,{},"two");assert.throws(()=>queue.retry(cancelled.id),/대기 작업 한도/);assert.equal(queue.get(cancelled.id)?.status,"cancelled");}finally{store.close();}
});
test("AI draft usage atomically honors organization and service budgets without creating a fictitious project",()=>{
  const keys=["GENERATION_API_URL","GENERATION_MONTHLY_LIMIT","GENERATION_REQUEST_COST_MINOR","GENERATION_SPEND_LIMIT_MINOR"] as const,previous=Object.fromEntries(keys.map(key=>[key,process.env[key]])),store=new Store(":memory:");
  try{process.env.GENERATION_API_URL="https://generation.example.test";process.env.GENERATION_MONTHLY_LIMIT="10";delete process.env.GENERATION_REQUEST_COST_MINOR;delete process.env.GENERATION_SPEND_LIMIT_MINOR;
    const expansion=new ExpansionService(store,{mode:"local",dataRoot:os.tmpdir(),siteData:async()=>{throw new Error("not used");},enqueueJob:async()=>{throw new Error("not used");}}),organization=expansion.organizations.createOrganization(null,true,{name:"budget"});expansion.usage.limit(organization.id,{metric:"ai.requests",amount:1});
    reserveGeneration(store,organization.id);assert.throws(()=>reserveGeneration(store,organization.id),/조직의 AI 요청/);const month=new Date().toISOString().slice(0,7);assert.deepEqual(store.operations.state(`aiUsageOrg:${organization.id}:${month}`)&&Reflect.get(store.operations.state(`aiUsageOrg:${organization.id}:${month}`) as object,"used"),1);assert.equal(Reflect.get(store.operations.state(`aiUsage:${month}`) as object,"used"),1);assert.equal(store.projects().length,0);
  }finally{for(const key of keys){const value=previous[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}store.close();}
});
