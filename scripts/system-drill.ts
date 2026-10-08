import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {Store} from '../server/store';
import {createProject} from '../src/domain/catalog';
import {SystemDelivery,enqueueSystemEvent} from '../server/systemDelivery';
import {WorkQueue} from '../server/workQueue';
import {sourceIdentity} from './source-identity.mjs';
const currentFile=fileURLToPath(import.meta.url),mode=process.argv[2];
if(mode==='--child'){
 const action=process.argv[3],folder=process.argv[4]!,central=new Store(path.join(folder,'central.sqlite'));
 if(action==='transaction'){central.db.exec('BEGIN IMMEDIATE');central.db.prepare("UPDATE projects SET body=json_set(body,'$.name','uncommitted')").run();process.exit(91);}
 if(action==='delivery'){const site=new Store(path.join(folder,'site.sqlite'));const delivery=new SystemDelivery(central.db,async()=>({db:site.db,assertWritable:()=>site.assertWritable()}),()=>{});await delivery.deliverOne(()=>process.exit(92));process.exit(2);}
 if(action==='lease'){new WorkQueue(central.db,'crashed',2).claim(1000);process.exit(93);}
 throw new Error('Unknown child action');
}
const folder=await mkdtemp(path.join(tmpdir(),'automade-drill-')),project=createProject('preserved'),scope={organizationId:'local',workspaceId:'local',projectId:project.id,dataKey:project.id};let db=new Store(path.join(folder,'central.sqlite'));db.save(project);const fingerprint=()=>createHash('sha256').update(String(db.db.prepare('SELECT body FROM projects WHERE id=?').get(project.id)?.body)).digest('hex'),before=fingerprint();
const child=(action:string,code:number)=>new Promise<void>((resolve,reject)=>{const p=spawn(process.execPath,['--import','tsx',currentFile,'--child',action,folder],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','ignore','pipe']});let error='';p.stderr.on('data',data=>{error+=String(data).slice(0,2000);});p.once('error',reject);p.once('exit',status=>status===code?resolve():reject(new Error('Drill child failed '+status+': '+error)));});
const started=Date.now(),results:{id:string;status:'passed';evidence:unknown}[]=[];
try{
 db.close();await child('transaction',91);db=new Store(path.join(folder,'central.sqlite'));assert.equal(fingerprint(),before);results.push({id:'uncommitted-process-exit',status:'passed',evidence:{projectHashPreserved:true}});
 enqueueSystemEvent(db.db,{scope,kind:'content.snapshot',sequence:1,payload:{revision:1,collections:[]}});db.close();await child('delivery',92);db=new Store(path.join(folder,'central.sqlite'));const site=new Store(path.join(folder,'site.sqlite'));try{assert.equal(site.db.prepare('SELECT COUNT(*) AS n FROM system_event_inbox').get()?.n,1);const delivery=new SystemDelivery(db.db,async()=>({db:site.db,assertWritable:()=>site.assertWritable()}),()=>{},()=>Date.now()+31000);await delivery.deliverOne();assert.equal(db.db.prepare('SELECT status FROM system_event_outbox').get()?.status,'delivered');assert.equal(site.db.prepare('SELECT COUNT(*) AS n FROM system_event_inbox').get()?.n,1);results.push({id:'destination-commit-before-ack-exit',status:'passed',evidence:{appliedOnce:true,ackRecovered:true}});}finally{site.close();}
 const queue=new WorkQueue(db.db),item=queue.enqueue('content.publish',scope,{},'recover');db.close();await child('lease',93);db=new Store(path.join(folder,'central.sqlite'));const replacement=new WorkQueue(db.db,'replacement',2,()=>Date.now()+2000),claim=replacement.claim(1000)!;assert.equal(claim.id,item.id);assert.equal(claim.attempts,2);assert.equal(replacement.complete(claim,{recovered:true}),true);results.push({id:'worker-process-exit',status:'passed',evidence:{newLeaseRecovered:true}});
 db.db.exec('CREATE TABLE drill_pressure(value BLOB)');const pages=Number(db.db.prepare('PRAGMA page_count').get()?.page_count);db.db.exec('PRAGMA max_page_count='+pages);let code:string|undefined;try{db.db.prepare('INSERT INTO drill_pressure VALUES(?)').run(Buffer.alloc(20*1024*1024));}catch(error){code=(error as NodeJS.ErrnoException).code;}assert.ok(code);assert.equal(fingerprint(),before);assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM drill_pressure').get()?.n,0);results.push({id:'sqlite-quota-full',status:'passed',evidence:{errorCode:code,projectHashPreserved:true,scope:'SQLite quota injection; not OS disk exhaustion'}});
 const report={format:1,buildHash:sourceIdentity(process.cwd()).hash,isolated:true,results,durationMs:Date.now()-started,createdAt:new Date().toISOString()};await mkdir('.data',{recursive:true});await writeFile('.data/system-drills.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{db.close();}
