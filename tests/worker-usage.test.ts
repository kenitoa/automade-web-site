import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {record} from '../src/domain/validation';
import {parseWorkerUsage} from '../server/workerUsage';
import {Store} from '../server/store';
import {WorkQueue} from '../server/workQueue';
import {ExpansionService} from '../server/expansion/service';
import {createProject} from '../src/domain/catalog';

async function sourceWorker(entry:string,input:Record<string,unknown>):Promise<Record<string,unknown>> {
  const child=fork(path.join(process.cwd(),'server',entry),[],{silent:true,windowsHide:true,execArgv:['--import','tsx']});child.stdout?.resume();child.stderr?.resume();
  try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Source worker fixture timed out')),90000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Source worker exited without final usage: '+code));});child.on('message',(raw:unknown)=>{const message=record(raw);if(message.type==='result'||message.type==='error'){clearTimeout(timer);resolve(message);}});child.send(input);});}
  finally{if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill();await exited;}}
}

test('actual successful and failing generation and expansion workers retain CPU observations once in the resolved environment',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'automade-worker-usage-')),dataRoot=path.join(root,'data');await mkdir(dataRoot);const studioFile=path.join(dataRoot,'central.sqlite'),dataFile=path.join(dataRoot,'visitor.sqlite'),store=new Store(studioFile),site=new Store(dataFile),expansion=new ExpansionService(store,{mode:'local',dataRoot,siteData:async()=>site,enqueueJob:async()=>{throw new Error('Worker owns its coordinator');}});
  try{
    const project=createProject('Measured worker');project.settings.description='CPU observation fixture';store.save(project);const scope=expansion.registerProject(project,'local',null,true),queue=new WorkQueue(store.db,'usage-fixture',2),observations:Record<string,unknown>[]=[];
    const observe=(message:Record<string,unknown>):void=>{assert.equal(message.protocol,1);const usage=parseWorkerUsage(message.usage);expansion.usage.observe(scope,usage.operationId,'cpu',usage.cpuMs);expansion.usage.observe(scope,usage.operationId,'cpu',usage.cpuMs);observations.push(message);};
    for(const actor of ['local-owner','revoked-actor']){const item=queue.enqueue('booking.waitlist',scope,{},'waitlist-'+actor,actor),claim=queue.claim()!;assert.equal(claim.id,item.id);const message=await sourceWorker('expansionWorker.ts',{protocol:1,studioFile,dataRoot,jobId:item.id,workerId:claim.workerId,leaseToken:claim.leaseToken});assert.equal(message.type,actor==='local-owner'?'result':'error');if(actor==='revoked-actor')assert.equal(message.code,'JOB_ACTOR');observe(message);if(message.type==='result')assert.equal(queue.complete(claim,message.result),true);else assert.equal(queue.fail(claim,String(message.code)),true);}
    const generation={protocol:1,project,sourceRoot:process.cwd(),exportRoot:path.join(root,'exports'),dataFile,studioFile,id:randomUUID()},success=await sourceWorker('generationWorker.ts',generation);assert.equal(success.type,'result');observe(success);
    const failure=await sourceWorker('generationWorker.ts',{...generation,protocol:2,id:randomUUID()});assert.equal(failure.type,'error');assert.equal(failure.code,'WORKER_PROTOCOL');observe(failure);
    const evidence=expansion.usage.evidence(scope);assert.equal(evidence.actual.length,4);assert.ok(evidence.actual.every(row=>row.metric==='cpu'&&row.unit==='milliseconds'));assert.equal(evidence.aggregate.find(row=>row.metric==='cpu')?.amount,observations.reduce((sum,message)=>sum+parseWorkerUsage(message.usage).cpuMs,0));const environment=expansion.organizations.createEnvironment(null,true,{siteId:scope.siteId,name:'Separate usage fixture',kind:'staging'});assert.equal(expansion.usage.evidence(expansion.resolveEnvironmentScope(environment.id)).actual.length,0);
  }finally{site.close();store.close();}
});
