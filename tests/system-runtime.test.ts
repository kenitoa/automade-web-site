import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store';
import {createProject,createBlock} from '../src/domain/catalog';
import {applyProjectCommand,commandFingerprint,parseProjectCommand} from '../server/projectCommands';
import {SystemDelivery,enqueueSystemEvent,persistedEnvironmentScopes} from '../server/systemDelivery';
import {WorkQueue} from '../server/workQueue';
import {HttpError} from '../server/http';
const scope={organizationId:'local',workspaceId:'local',projectId:'site',environmentId:'production',dataKey:'site'};
test('command receipts atomically commit once, replay after response loss, and isolate actors',()=>{
 const store=new Store(':memory:');try{const p=createProject('before');store.save(p);const command=parseProjectCommand({commandId:'change-1',baseRevision:0,proposedRevision:3,changes:[{path:'/name',before:'before',after:'after'}]}),hash=commandFingerprint(command);
 const first=store.saveCommand(p.id,'actor-a',command.commandId,hash,current=>applyProjectCommand(current,command));assert.equal(first.revision,3);assert.equal(first.project.name,'after');
 const replay=store.saveCommand(p.id,'actor-a',command.commandId,hash,()=>{throw new Error('must not execute');});assert.equal(replay.replayed,true);assert.equal(store.backups(p.id).length,1);assert.equal(store.commandReceipts(p.id,'actor-b',['change-1']).length,0);assert.throws(()=>store.saveCommand(p.id,'actor-a',command.commandId,'different',()=>p),(e:unknown)=>e instanceof HttpError&&e.code==='COMMAND_IDEMPOTENCY');
 const failed=parseProjectCommand({commandId:'change-2',baseRevision:3,changes:[{path:'/name',before:'wrong',after:'broken'}]});assert.throws(()=>store.saveCommand(p.id,'actor-a',failed.commandId,commandFingerprint(failed),current=>applyProjectCommand(current,failed)));assert.equal(store.project(p.id)?.name,'after');assert.equal(store.commandReceipts(p.id,'actor-a',['change-2']).length,0);
 }finally{store.close();}
});
test('commands reject protected and prototype paths and select stable block IDs',()=>{
 const p=createProject(),block=createBlock('text',p,p.pages[0]!.id);p.blocks.push(block);const command=parseProjectCommand({commandId:'block',baseRevision:0,changes:[{path:`/blocks/@${block.id}/name`,before:block.name,after:'stable block'}]});assert.equal(applyProjectCommand(p,command).blocks[0]?.name,'stable block');
 for(const path of ['/revision','/id','/__proto__/polluted','/blocks/0/name','/blocks/@missing/name'])assert.throws(()=>applyProjectCommand(p,parseProjectCommand({commandId:'invalid',baseRevision:0,changes:[{path,before:null,after:'x'}]})));
});
test('outbox survives destination commit without central ACK and ignores stale publication sequence',async()=>{
 const central=new Store(':memory:'),site=new Store(':memory:');let now=Date.now()+100;const target=async()=>({db:site.db,assertWritable:()=>site.assertWritable()}),delivery=new SystemDelivery(central.db,target,()=>{},()=>now);
 try{const id=enqueueSystemEvent(central.db,{scope,kind:'content.snapshot',sequence:2,payload:{revision:2,collections:[]}});await assert.rejects(delivery.deliverOne(()=>{throw new Error('simulated response loss');}));assert.equal(site.db.prepare('SELECT COUNT(*) AS n FROM system_event_inbox').get()?.n,1);now+=6000;await delivery.deliverOne();assert.equal(central.db.prepare('SELECT status FROM system_event_outbox WHERE id=?').get(id)?.status,'delivered');assert.equal(site.db.prepare('SELECT COUNT(*) AS n FROM system_event_inbox').get()?.n,1);
 enqueueSystemEvent(central.db,{scope,kind:'content.snapshot',sequence:1,payload:{revision:1,collections:[]}});await delivery.deliverOne();assert.equal(JSON.parse(String(site.db.prepare("SELECT value FROM runtime_state WHERE key='project:cms'").get()?.value)).revision,2);assert.throws(()=>enqueueSystemEvent(central.db,{scope,kind:'content.snapshot',sequence:2,payload:{revision:2,collections:[{id:'different'}]}}));
 central.db.exec('BEGIN IMMEDIATE');enqueueSystemEvent(central.db,{scope,kind:'content.snapshot',sequence:3,payload:{revision:3,collections:[]}});central.db.exec('ROLLBACK');assert.equal(central.db.prepare('SELECT COUNT(*) AS n FROM system_event_outbox').get()?.n,2);
 }finally{central.close();site.close();}
});
test('persisted discovery finds unopened environments and excludes archived sites',()=>{
 const store=new Store(':memory:');try{const p=createProject();store.save(p);store.db.prepare('INSERT INTO expansion_project_scopes VALUES(?,?,?)').run(p.id,'local','local');store.db.prepare("INSERT INTO expansion_sites VALUES(?,?,?,?,'site','local',0,'{}',?)").run(p.id,'local','local',p.id,new Date().toISOString());store.db.prepare("INSERT INTO expansion_environments VALUES(?,?,?,?,?,'production','production',?,1,'{}',?)").run('env',p.id,'local','local',p.id,p.id,new Date().toISOString());assert.equal(persistedEnvironmentScopes(store.db)[0]?.environmentId,'env');store.db.prepare('UPDATE expansion_sites SET archived=1 WHERE id=?').run(p.id);assert.deepEqual(persistedEnvironmentScopes(store.db),[]);}finally{store.close();}
});
test('worker pools preserve recovery capacity, fence policy drift and expire deadlines',()=>{
 const store=new Store(':memory:');let now=1000;const queue=new WorkQueue(store.db,'worker',2,()=>now);try{queue.limits('local',2,100);const cpu=queue.enqueue('site.generate',scope,{},'cpu',undefined,{pool:'cpu',weight:2}),io=queue.enqueue('connection.send',scope,{},'io',undefined,{pool:'io'}),recovery=queue.enqueue('data.verify',scope,{},'recovery',undefined,{pool:'recovery'});assert.equal(queue.claim()?.id,cpu.id);assert.equal(queue.claim()?.id,recovery.id);assert.equal(queue.get(io.id)?.status,'waiting');assert.throws(()=>new WorkQueue(store.db,'misconfigured',1),/동시 실행/);queue.enqueue('data.verify',scope,{},'expires',undefined,{deadline:now+100});now+=101;queue.claim();assert.equal(store.db.prepare("SELECT error_code FROM work_items WHERE request_key='expires'").get()?.error_code,'WORK_DEADLINE');}finally{store.close();}
});
test('drain completes even when a handler ignores abort, with late completion fenced',async()=>{
 const store=new Store(':memory:'),queue=new WorkQueue(store.db);const item=queue.enqueue('content.publish',scope,{},'hang');try{const pending=queue.processOne(async()=>new Promise(()=>{}));await queue.close();await pending;assert.equal(queue.get(item.id)?.status,'cancelled');}finally{store.close();}
});
